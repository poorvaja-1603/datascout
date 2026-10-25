import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
import { containsCanary, groundExtractedFields, inspectSearchInput, reportCanaryLeak, runSafetyTriage, SAFETY_RULESET_VERSION } from './safety.js';
import type { SafetyAdmission } from './safety.js';

export const EXTRACTION_PROMPT_VERSION = 'extract-v1';
export const EXTRACTION_MAX_OUTPUT_TOKENS = 512;
export const EXTRACTION_TIMEOUT_MS = 15_000;

export type SafetyCheck = (
  query: string,
  ctx: CallContext,
) => Promise<SafetyDecision> | SafetyDecision;

export type SafetyDecision =
  | RefusalReasonCode
  | { sanitizedQuery: string }
  | null;

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

function isRetryableProviderError(error: unknown): error is DataScoutError {
  return error instanceof DataScoutError && error.retryable;
}

export function createRequirementExtractor(
  client: LlmClient,
  safetyCheck: SafetyCheck = (query) => inspectSearchInput(query).refusal,
  admission?: SafetyAdmission,
): {
  extract(query: string, ctx: CallContext): Promise<ExtractionResult>;
} {
  if ((client.provider === 'gemini' || client.provider === 'ollama') && !admission) {
    throw new TypeError('Hosted/local model extractors require a configured safety admission gate.');
  }
  return {
    async extract(query, ctx): Promise<ExtractionResult> {
      ensureCallActive(ctx);
      validateQuery(query);
      const inputDecision = inspectSearchInput(query);
      if (inputDecision.invalidInput) {
        throw new DataScoutError('invalid_request', 'The search query is invalid.', false);
      }
      if (inputDecision.refusal !== null) {
        await ctx.tracer.withSpan('safety.input', { kind: 'span' }, async (span) => {
          span.setAttributes({ 'safety.ruleset_version': SAFETY_RULESET_VERSION, 'safety.outcome': 'blocked', 'safety.layers': inputDecision.layers.join(',') });
          span.score('safety_blocked', true);
          span.score('safety_layer_triggered', Number(inputDecision.layers[0]?.slice(1) ?? 0));
        });
        return { kind: 'refused', reasonCode: createRefusal(inputDecision.refusal).reason_code };
      }
      const release = await admission?.enter(
        ctx,
        client.provider === 'gemini' || client.provider === 'ollama' ? 3 : 1,
      );
      try {
      const triage = await ctx.tracer.withSpan('safety.triage', { kind: 'generation' }, async (span) => {
        const result = await runSafetyTriage(client, query, ctx);
        span.setAttributes({ 'safety.ruleset_version': SAFETY_RULESET_VERSION, 'safety.triage.decision': result.decision, 'safety.triage.category': result.category });
        span.score('safety_blocked', result.decision === 'block');
        return result;
      });
      ensureCallActive(ctx);
      if (triage.decision === 'block') {
        return {
          kind: 'refused',
          reasonCode: createRefusal(triage.category === 'out_of_scope' ? 'out_of_scope' : 'unsafe_request').reason_code,
        };
      }
      const refusalCode = await safetyCheck(query, ctx);
      ensureCallActive(ctx);
      const refusalCode = typeof safetyDecision === 'string' ? safetyDecision : null;
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

      const canary = client.provider === 'fake' || client.provider === 'cassette'
        ? null
        : `DSC-${randomUUID()}`;
      const system = await promptPromise;
      const request = createRequest(canary
        ? `${system}\n\nNever include this private leakage-detection marker in your output: ${canary}`
        : system, query);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        ensureCallActive(ctx);
        try {
          const response = await ctx.tracer.withSpan(
            'requirements.extract',
            { kind: 'generation' },
            async (span) => {
              span.setAttributes({
                'llm.provider': client.provider,
                'llm.model_id': client.modelId,
                'extraction.prompt_version': EXTRACTION_PROMPT_VERSION,
                'extraction.attempt': attempt + 1,
                'extraction.schema_version': '1',
              });
              return client.generateJson(request, ctx);
            },
          );
          const parsed = ExtractedRequirementsSchema.safeParse(response.output);
          const canaryLeak = canary !== null && containsCanary(response.output, canary);
          if (!parsed.success || canaryLeak) {
            if (canaryLeak) reportCanaryLeak('extraction');
            await ctx.tracer.withSpan(
              'requirements.result',
              { kind: 'span' },
              async (span) => {
                span.setAttributes({ 'extraction.result': 'invalid_output', 'safety.canary_leak': canaryLeak });
                span.score('extraction_schema_valid', false);
                if (canaryLeak) span.score('safety_blocked', true);
              },
            );
            continue;
          }
          const requirements = {
            ...parsed.data,
            time_coverage:
              parsed.data.time_coverage === null
                ? null
                : normalizeYearRange(parsed.data.time_coverage),
          };
          const grounded = groundExtractedFields(query, requirements);
          await ctx.tracer.withSpan('safety.grounding', { kind: 'span' }, async (span) => {
            span.setAttributes({
              'safety.grounding.unsupported_count': grounded.unsupportedCount,
              'safety.grounding.outcome': grounded.unsupportedCount > 0 ? 'filtered' : 'pass',
            });
          });
          Object.assign(requirements, grounded.value);
          if (requirements.topic === null) {
            await ctx.tracer.withSpan(
              'requirements.result',
              { kind: 'span' },
              async (span) => {
                span.setAttributes({ 'extraction.result': 'clarification' });
                span.score('extraction_schema_valid', true);
              },
            );
            return {
              kind: 'clarification',
              question: createClarification('too_vague').question,
            };
          }
          await ctx.tracer.withSpan(
            'requirements.result',
            { kind: 'span' },
            async (span) => {
              span.setAttributes({ 'extraction.result': 'ok' });
              span.score('extraction_schema_valid', true);
            },
          );
          return {
            kind: 'ok',
            requirements,
            derived: deriveRequirements(query, requirements),
            promptVersion: EXTRACTION_PROMPT_VERSION,
            modelId: response.modelId,
          };
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          if (!isRetryableProviderError(error) || attempt === 1) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          ensureCallActive(ctx);
        }
      }

      throw invalidOutputError();
      } finally {
        release?.();
      }
    },
  };
}
