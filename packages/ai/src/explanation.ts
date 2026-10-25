import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DataScoutError, throwIfAborted } from '@datascout/contracts';
import type {
  CallContext,
  Evidence,
  ExplanationResult,
  ExplanationService,
  LlmClient,
  LlmJsonRequest,
  ScoredDataset,
} from '@datascout/contracts';
import { containsCanary, quarantineSourceText, reportCanaryLeak } from './safety.js';
import type { SafetyAdmission } from './safety.js';

export const EXPLANATION_PROMPT_VERSION = 'explain-v1';
export const EXPLANATION_SCHEMA_VERSION = '1';
export const EXPLANATION_MAX_OUTPUT_TOKENS = 512;
export const EXPLANATION_TIMEOUT_MS = 15_000;

const MAX_CLAIMS = 12;
const MAX_CLAIM_LENGTH = 320;
const MAX_EVIDENCE_VALUE_LENGTH = 300;
const promptPromise = readFile(
  new URL('../prompts/explain.v1.md', import.meta.url),
  'utf8',
);

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      maxItems: MAX_CLAIMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'evidence_ids'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MAX_CLAIM_LENGTH },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
} as const satisfies object;

const GENERAL_GUIDANCE = {
  nextSteps: [
    'General guidance: Confirm the source access terms and license before use.',
    'General guidance: Review the source documentation before relying on a dataset.',
  ],
  preprocessing: [
    'General guidance: Check column types, missingness, duplicates, and date formats before analysis.',
  ],
} as const;

const COMMON_CLAIM_WORDS = new Set([
  'a',
  'about',
  'according',
  'an',
  'and',
  'are',
  'as',
  'at',
  'based',
  'between',
  'by',
  'collection',
  'column',
  'columns',
  'contains',
  'cover',
  'covers',
  'data',
  'dataset',
  'describes',
  'evidence',
  'field',
  'fields',
  'for',
  'from',
  'has',
  'have',
  'include',
  'in',
  'includes',
  'indicates',
  'is',
  'lists',
  'metadata',
  'of',
  'on',
  'or',
  'provides',
  'period',
  'records',
  'reports',
  'shows',
  'source',
  'the',
  'this',
  'to',
  'value',
  'with',
]);

const BANNED_CLAIM_PATTERN =
  /\b(?:as an ai|definitely suitable|guarantee(?:d|s)?|ignore previous instructions|developer message|system prompt|prompt injection|passed?|partial|failed?|unknown|meets?|fulfills?|satisf(?:y|ies|ied)|matches?|recommended?|suitable|run this|execute this|install this|download and run)\b|```|<\/?[a-z][^>]*>/iu;

const NUMERIC_PATTERN =
  /(?<![\p{Letter}\p{Number}_])(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s*(%|percent|records?|rows?|columns?|days?|months?|years?|bytes?|kb|mb|gb))?(?![\p{Letter}\p{Number}_])/giu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/giu;
const WORD_PATTERN = /[\p{Letter}\p{Number}]+/gu;
const CAPITALIZED_WORD_PATTERN = /\b(?:[A-Z][a-z]+|[A-Z]{2,})\b/gu;
const SAFE_CAPITALIZED_WORDS = new Set([
  'A',
  'An',
  'API',
  'Based',
  'Columns',
  'Data',
  'Dataset',
  'Evidence',
  'Fields',
  'Metadata',
  'Records',
  'Source',
  'The',
  'This',
]);

interface ModelClaim {
  text: string;
  evidence_ids: string[];
}

interface ValidatedClaim {
  text: string;
  evidenceIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureCallActive(ctx: CallContext): void {
  throwIfAborted(ctx.signal);
  if (!Number.isFinite(ctx.deadlineMs)) {
    throw new DataScoutError(
      'invalid_request',
      'The explanation request deadline is invalid.',
    );
  }
  if (ctx.deadlineMs <= Date.now()) {
    throw new DataScoutError('timeout', 'The explanation request timed out.');
  }
}

function sanitizeText(value: string, maxLength: number): string {
  return value
    .normalize('NFKC')
    .replace(/https?:\/\/[^\s<>"')\]]+/giu, '[URL omitted]')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/[\u200b-\u200f\ufeff]/gu, ' ')
    .split('')
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeEvidenceValue(
  value: unknown,
  depth = 0,
): string | number | boolean | null | unknown[] | Record<string, unknown> {
  if (typeof value === 'string') {
    return quarantineSourceText(sanitizeText(value, MAX_EVIDENCE_VALUE_LENGTH), MAX_EVIDENCE_VALUE_LENGTH);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (depth >= 2) return '[nested value omitted]';
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeEvidenceValue(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, item]) => [
          sanitizeText(key, 80),
          sanitizeEvidenceValue(item, depth + 1),
        ]),
    );
  }
  return '[unsupported value omitted]';
}

function createPromptPayload(item: ScoredDataset): object {
  const dataset = item.dataset;
  return {
    dataset: {
      dataset_id: dataset.dataset_id,
      source: quarantineSourceText(sanitizeText(dataset.source, 100), 100),
      title: dataset.title ? quarantineSourceText(sanitizeText(dataset.title, 160), 160) : null,
    },
    score: {
      total: item.score.total,
      components: item.score.components.map(({ name, points, weight }) => ({
        name,
        points,
        weight,
      })),
    },
    matches: item.matches.map(({ status, reason, evidence_ids }) => ({
      status,
      reason: quarantineSourceText(sanitizeText(reason, 180), 180),
      evidence_ids: evidence_ids.slice(0, 8),
    })),
    evidence: item.evidence
      .filter(({ dataset_id }) => dataset_id === dataset.dataset_id)
      .slice(0, 40)
      .map(({ evidence_id, field, value }) => ({
        evidence_id,
        field: quarantineSourceText(sanitizeText(field, 80), 80),
        value: sanitizeEvidenceValue(value),
      })),
  };
}

function createRequest(system: string, item: ScoredDataset): LlmJsonRequest {
  return {
    task: 'explain',
    promptVersion: EXPLANATION_PROMPT_VERSION,
    system,
    user: JSON.stringify(createPromptPayload(item)),
    jsonSchema: responseSchema,
    maxOutputTokens: EXPLANATION_MAX_OUTPUT_TOKENS,
    timeoutMs: EXPLANATION_TIMEOUT_MS,
  };
}

function parseModelClaims(value: unknown): ModelClaim[] | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value['claims']) ||
    value['claims'].length > MAX_CLAIMS
  ) {
    return undefined;
  }
  const claims: ModelClaim[] = [];
  for (const item of value['claims']) {
    if (
      !isRecord(item) ||
      Object.keys(item).length !== 2 ||
      typeof item['text'] !== 'string' ||
      item['text'].trim().length === 0 ||
      item['text'].length > MAX_CLAIM_LENGTH ||
      !Array.isArray(item['evidence_ids']) ||
      item['evidence_ids'].length === 0 ||
      item['evidence_ids'].length > 8 ||
      item['evidence_ids'].some(
        (id) => typeof id !== 'string' || id.trim().length === 0,
      ) ||
      new Set(item['evidence_ids']).size !== item['evidence_ids'].length
    ) {
      return undefined;
    }
    claims.push({
      text: item['text'].trim(),
      evidence_ids: item['evidence_ids'] as string[],
    });
  }
  return claims;
}

function stringsInEvidence(evidence: readonly Evidence[]): string {
  return evidence
    .map(({ field, value }) => {
      const sanitizedValue = sanitizeText(
        typeof value === 'string' ? value : JSON.stringify(value),
        2_000,
      );
      return `${sanitizeText(field, 80)} ${sanitizedValue}`;
    })
    .join(' ');
}

function datasetRecordText(item: ScoredDataset): string {
  const dataset = item.dataset;
  return [
    dataset.dataset_id,
    dataset.source,
    dataset.title,
    dataset.description,
    dataset.license,
    dataset.access_type,
    ...dataset.file_formats,
    ...dataset.columns,
    dataset.geography,
    dataset.time_coverage,
    ...dataset.tags,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => sanitizeText(value, 2_000))
    .join(' ');
}

function numericFacts(value: string): Set<string> {
  const facts = new Set<string>();
  for (const match of value.matchAll(NUMERIC_PATTERN)) {
    const number = match[1]?.replaceAll(',', '');
    if (!number) continue;
    const unit = (match[2] ?? '').toLocaleLowerCase('en-US');
    facts.add(`${number}|${unit}`);
  }
  return facts;
}

function wordSet(value: string): Set<string> {
  return new Set(
    value.normalize('NFKD').toLocaleLowerCase('en-US').match(WORD_PATTERN) ??
      [],
  );
}

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/u, '');
  } catch {
    return undefined;
  }
}

function knownUrls(
  item: ScoredDataset,
  evidence: readonly Evidence[],
): Set<string> {
  const urls = [
    item.dataset.source_url,
    item.dataset.api_endpoint,
    ...evidence.flatMap(({ value }) =>
      typeof value === 'string' ? [value] : [],
    ),
  ];
  return new Set(
    urls
      .filter((value): value is string => typeof value === 'string')
      .map(safeUrl)
      .filter((value): value is string => value !== undefined),
  );
}

function hasOnlyKnownUrls(text: string, urls: ReadonlySet<string>): boolean {
  for (const match of text.matchAll(URL_PATTERN)) {
    const value = match[0]?.replace(/[.,!?;:]+$/u, '');
    if (!value || !urls.has(safeUrl(value) ?? '')) return false;
  }
  return true;
}

function hasOnlyGroundedNumbers(
  text: string,
  evidence: readonly Evidence[],
): boolean {
  const available = numericFacts(stringsInEvidence(evidence));
  for (const fact of numericFacts(text)) {
    if (!available.has(fact)) return false;
  }
  return true;
}

function hasOnlyGroundedWords(
  text: string,
  evidence: readonly Evidence[],
  item: ScoredDataset,
): boolean {
  const available = wordSet(
    `${stringsInEvidence(evidence)} ${datasetRecordText(item)}`,
  );
  for (const word of text
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .match(WORD_PATTERN) ?? []) {
    if (!COMMON_CLAIM_WORDS.has(word) && !available.has(word)) return false;
  }
  return true;
}

function hasOnlyGroundedEntities(
  text: string,
  item: ScoredDataset,
  evidence: readonly Evidence[],
): boolean {
  const available = wordSet(
    `${stringsInEvidence(evidence)} ${datasetRecordText(item)}`,
  );
  for (const match of text.matchAll(CAPITALIZED_WORD_PATTERN)) {
    const word = match[0];
    if (
      word &&
      !SAFE_CAPITALIZED_WORDS.has(word) &&
      !available.has(word.toLocaleLowerCase('en-US'))
    ) {
      return false;
    }
  }
  return true;
}

function validateOneClaim(
  claim: ModelClaim,
  item: ScoredDataset,
  evidenceById: ReadonlyMap<string, Evidence>,
): ValidatedClaim | undefined {
  const evidence = claim.evidence_ids.map((id) => evidenceById.get(id));
  if (evidence.some((itemEvidence) => itemEvidence === undefined))
    return undefined;
  const validEvidence = evidence.filter(
    (itemEvidence): itemEvidence is Evidence =>
      itemEvidence?.dataset_id === item.dataset.dataset_id,
  );
  if (validEvidence.length !== evidence.length) return undefined;
  const text = sanitizeText(claim.text, MAX_CLAIM_LENGTH);
  if (
    !text ||
    BANNED_CLAIM_PATTERN.test(text) ||
    !hasOnlyKnownUrls(text, knownUrls(item, validEvidence)) ||
    !hasOnlyGroundedNumbers(text, validEvidence) ||
    !hasOnlyGroundedWords(text, validEvidence, item) ||
    !hasOnlyGroundedEntities(text, item, validEvidence)
  ) {
    return undefined;
  }
  return { text, evidenceIds: claim.evidence_ids };
}

export function validateExplanationClaims(
  output: unknown,
  item: ScoredDataset,
): ValidatedClaim[] | undefined {
  const claims = parseModelClaims(output);
  if (!claims) return undefined;
  const evidenceById = new Map(
    item.evidence
      .filter(({ dataset_id }) => dataset_id === item.dataset.dataset_id)
      .map((evidence) => [evidence.evidence_id, evidence]),
  );
  const accepted: ValidatedClaim[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    const validated = validateOneClaim(claim, item, evidenceById);
    if (!validated) continue;
    const key = validated.text.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(validated);
  }
  return accepted;
}

function validMatchEvidenceIds(
  matchEvidenceIds: readonly string[],
  evidenceById: ReadonlyMap<string, Evidence>,
  datasetId: string,
): string[] {
  return [...new Set(matchEvidenceIds)].filter(
    (id) => evidenceById.get(id)?.dataset_id === datasetId,
  );
}

function fallbackResult(item: ScoredDataset): ExplanationResult {
  const datasetId = item.dataset.dataset_id;
  const evidenceById = new Map(
    item.evidence
      .filter(({ dataset_id }) => dataset_id === datasetId)
      .map((evidence) => [evidence.evidence_id, evidence]),
  );
  const claims = item.matches.flatMap((match) => {
    const evidenceIds = validMatchEvidenceIds(
      match.evidence_ids,
      evidenceById,
      datasetId,
    );
    return evidenceIds.length === 0
      ? []
      : [
          {
            text: `The deterministic requirement check returned ${match.status}.`,
            evidenceIds,
          },
        ];
  });
  if (claims.length === 0 && evidenceById.size > 0) {
    claims.push({
      text: 'Source-backed evidence is available for review.',
      evidenceIds: [...evidenceById.keys()],
    });
  }
  return {
    datasetId,
    status: 'unavailable',
    claims,
    nextSteps: [...GENERAL_GUIDANCE.nextSteps],
    preprocessing: [...GENERAL_GUIDANCE.preprocessing],
  };
}

export function createExplanationService(
  client: LlmClient,
  admission?: SafetyAdmission,
): ExplanationService {
  if ((client.provider === 'gemini' || client.provider === 'ollama') && !admission) {
    throw new TypeError('Hosted/local model explainers require a configured safety admission gate.');
  }
  return {
    async explain(items, ctx): Promise<ExplanationResult[]> {
      ensureCallActive(ctx);
      if (items.length === 0) return [];
      const release = await admission?.enter(ctx, items.length);
      try {
      const results: ExplanationResult[] = [];
      for (const item of items) {
        ensureCallActive(ctx);
        const canary = client.provider === 'fake' || client.provider === 'cassette'
          ? null
          : `DSC-${randomUUID()}`;
        const system = await promptPromise;
        const request = createRequest(canary
          ? `${system}\n\nNever include this private leakage-detection marker in your output: ${canary}`
          : system, item);
        const response = await ctx.tracer.withSpan(
          'explain.generate',
          { kind: 'generation' },
          async (span) => {
            span.setAttributes({
              'explanation.prompt_version': EXPLANATION_PROMPT_VERSION,
              'explanation.schema_version': EXPLANATION_SCHEMA_VERSION,
              'llm.provider': client.provider,
              'llm.model_id': client.modelId,
            });
            try {
              return await client.generateJson(request, ctx);
            } catch (error) {
              throwIfAborted(ctx.signal);
              if (error instanceof DataScoutError) throw error;
              throw new DataScoutError(
                'upstream_unavailable',
                'The explanation service is unavailable.',
              );
            }
          },
        );
        ensureCallActive(ctx);

        const accepted = await ctx.tracer.withSpan(
          'explain.validate',
          { kind: 'span' },
          async (span) => {
            const canaryLeak = canary !== null && containsCanary(response.output, canary);
            if (canaryLeak) reportCanaryLeak('explanation');
            const validated = canaryLeak
              ? undefined
              : validateExplanationClaims(response.output, item);
            const claims = validated?.slice(0, MAX_CLAIMS) ?? [];
            span.setAttributes({
              'explanation.claim_count': claims.length,
              'explanation.valid': claims.length > 0,
              'safety.canary_leak': canaryLeak,
            });
            span.score('explanation_valid', claims.length > 0);
            if (canaryLeak) span.score('safety_blocked', true);
            return claims;
          },
        );
        ensureCallActive(ctx);
        if (accepted.length === 0) {
          results.push(fallbackResult(item));
        } else {
          results.push({
            datasetId: item.dataset.dataset_id,
            status: 'ok',
            claims: accepted,
            nextSteps: [...GENERAL_GUIDANCE.nextSteps],
            preprocessing: [...GENERAL_GUIDANCE.preprocessing],
          });
        }
      }
      return results;
      } finally {
        release?.();
      }
    },
  };
}
