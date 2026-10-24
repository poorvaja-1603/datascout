import { readFile } from 'node:fs/promises';
import {
  DataScoutError,
  ExtractedRequirementsSchema,
  RefusalReasonCodeSchema,
  SEARCH_QUERY_MAX_LENGTH,
  createClarification,
  createRefusal,
  throwIfAborted,
  toJsonSchemas,
} from '@datascout/contracts';
import type {
  CallContext,
  ExtractionResult,
  LlmClient,
  LlmJsonRequest,
  Requirement,
  RefusalReasonCode,
} from '@datascout/contracts';

export const EXTRACTION_PROMPT_VERSION = 'extract-v1';
export const EXTRACTION_MAX_OUTPUT_TOKENS = 512;
export const EXTRACTION_TIMEOUT_MS = 15_000;

export type SafetyCheck = (
  query: string,
  ctx: CallContext,
) => Promise<RefusalReasonCode | null> | RefusalReasonCode | null;

const extractionSchema = toJsonSchemas().ExtractedRequirements as object;
const promptPromise = readFile(
  new URL('../prompts/extract.v1.md', import.meta.url),
  'utf8',
);

function ensureCallActive(ctx: CallContext): void {
  throwIfAborted(ctx.signal);
  if (!Number.isFinite(ctx.deadlineMs)) {
    throw new DataScoutError(
      'invalid_request',
      'The extraction request deadline is invalid.',
    );
  }
  if (ctx.deadlineMs <= Date.now()) {
    throw new DataScoutError('timeout', 'The extraction request timed out.');
  }
}

function validateQuery(query: string): void {
  if (
    typeof query !== 'string' ||
    query.trim().length === 0 ||
    query.length > SEARCH_QUERY_MAX_LENGTH
  ) {
    throw new DataScoutError('invalid_request', 'The search query is invalid.');
  }
}

function normalizeYearRange(value: string): string {
  const match = value.match(
    /\b(?:from\s+|between\s+)?(\d{4})\s*(?:-|–|—|to|through|and)\s*(\d{4})\b/i,
  );
  return match ? `${match[1]}-${match[2]}` : value;
}

function spanForValue(
  query: string,
  value: string,
): Requirement['source_span'] {
  const exactMatch = new RegExp(
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    'iu',
  ).exec(query);
  if (exactMatch?.index !== undefined) {
    return {
      start: exactMatch.index,
      end: exactMatch.index + exactMatch[0].length,
      text: exactMatch[0],
    };
  }

  const yearRange = value.match(/^(\d{4})-(\d{4})$/);
  if (!yearRange) return null;
  const sourceRange = new RegExp(
    `\\b(?:from\\s+|between\\s+)?${yearRange[1]}\\s*(?:-|–|—|to|through|and)\\s*${yearRange[2]}\\b`,
    'iu',
  ).exec(query);
  if (sourceRange?.index === undefined) return null;
  return {
    start: sourceRange.index,
    end: sourceRange.index + sourceRange[0].length,
    text: sourceRange[0],
  };
}

function deriveRequirements(
  query: string,
  requirements: ReturnType<typeof ExtractedRequirementsSchema.parse>,
): Requirement[] {
  const fields: {
    field:
      | 'topic'
      | 'geography'
      | 'time_coverage'
      | 'minimum_records'
      | 'required_features'
      | 'target'
      | 'preferences'
      | 'constraints';
    values: Array<string | number>;
  }[] = [
    { field: 'topic', values: requirements.topic ? [requirements.topic] : [] },
    {
      field: 'geography',
      values: requirements.geography ? [requirements.geography] : [],
    },
    {
      field: 'time_coverage',
      values: requirements.time_coverage ? [requirements.time_coverage] : [],
    },
    {
      field: 'minimum_records',
      values:
        requirements.minimum_records === null
          ? []
          : [requirements.minimum_records],
    },
    { field: 'required_features', values: requirements.required_features },
    {
      field: 'target',
      values: requirements.target ? [requirements.target] : [],
    },
    { field: 'preferences', values: requirements.preferences },
    { field: 'constraints', values: requirements.constraints },
  ];
  const typeForField: Record<
    (typeof fields)[number]['field'],
    Requirement['type']
  > = {
    topic: 'topic',
    geography: 'geography',
    time_coverage: 'time_coverage',
    minimum_records: 'minimum_records',
    required_features: 'feature',
    target: 'target',
    preferences: 'preference',
    constraints: 'constraint',
  };
  const counters = new Map<Requirement['type'], number>();

  return fields.flatMap(({ field, values }) =>
    values.map((rawValue) => {
      const value =
        field === 'time_coverage' && typeof rawValue === 'string'
          ? normalizeYearRange(rawValue)
          : rawValue;
      const type = typeForField[field];
      const index = (counters.get(type) ?? 0) + 1;
      counters.set(type, index);

      return {
        requirement_id: `extract-${type}-${index}`,
        type,
        value,
        unit: field === 'minimum_records' ? 'records' : null,
        priority: field === 'preferences' ? 'preferred' : 'required',
        aliases: [],
        source_span:
          typeof value === 'string'
            ? spanForValue(query, value)
            : spanForValue(query, String(value)),
      };
    }),
  );
}

function createRequest(system: string, query: string): LlmJsonRequest {
  return {
    task: 'extract',
    promptVersion: EXTRACTION_PROMPT_VERSION,
    system,
    user: query,
    jsonSchema: extractionSchema,
    maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  };
}

function invalidOutputError(): DataScoutError {
  return new DataScoutError(
    'extraction_failed',
    'The requirement extractor returned invalid output.',
  );
}

function isRetryableTimeout(error: unknown): error is DataScoutError {
  return error instanceof DataScoutError && error.code === 'timeout';
}

export function createRequirementExtractor(
  client: LlmClient,
  safetyCheck: SafetyCheck,
): {
  extract(query: string, ctx: CallContext): Promise<ExtractionResult>;
} {
  return {
    async extract(query, ctx): Promise<ExtractionResult> {
      ensureCallActive(ctx);
      validateQuery(query);

      const refusalCode = await safetyCheck(query, ctx);
      ensureCallActive(ctx);
      if (refusalCode !== null) {
        const parsedReason = RefusalReasonCodeSchema.safeParse(refusalCode);
        if (!parsedReason.success) {
          throw new DataScoutError(
            'internal_error',
            'The request safety check returned an invalid decision.',
          );
        }
        return {
          kind: 'refused',
          reasonCode: createRefusal(parsedReason.data).reason_code,
        };
      }

      const request = createRequest(await promptPromise, query);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        ensureCallActive(ctx);
        try {
          const response = await client.generateJson(request, ctx);
          const parsed = ExtractedRequirementsSchema.safeParse(response.output);
          if (!parsed.success) {
            continue;
          }
          const requirements = {
            ...parsed.data,
            time_coverage:
              parsed.data.time_coverage === null
                ? null
                : normalizeYearRange(parsed.data.time_coverage),
          };
          if (requirements.topic === null) {
            return {
              kind: 'clarification',
              question: createClarification('too_vague').question,
            };
          }
          return {
            kind: 'ok',
            requirements,
            derived: deriveRequirements(query, requirements),
            promptVersion: EXTRACTION_PROMPT_VERSION,
            modelId: response.modelId,
          };
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          if (!isRetryableTimeout(error) || attempt === 1) throw error;
        }
      }

      throw invalidOutputError();
    },
  };
}
