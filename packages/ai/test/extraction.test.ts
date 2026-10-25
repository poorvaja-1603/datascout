import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DataScoutError,
  ExtractedRequirementsSchema,
  RequirementSchema,
  createRefusal,
  toJsonSchemas,
} from '@datascout/contracts';
import type {
  CallContext,
  LlmClient,
  LlmJsonRequest,
  LlmJsonResponse,
} from '@datascout/contracts';
import { createLlmClient, getCassetteKey } from '../src/client.js';
import { loadLlmConfig } from '../src/config.js';
import {
  EXTRACTION_MAX_OUTPUT_TOKENS,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_TIMEOUT_MS,
  createRequirementExtractor,
} from '../src/extraction.js';

interface CorpusCase {
  case_id: string;
  split: string;
  input: string;
  expected: {
    topic: string | null;
    geography: string | null;
    time_coverage: string | null;
    minimum_records: number | null;
    required_features: string[];
    target: string | null;
    preferences: string[];
    constraints: string[];
  };
}

const corpusPath = fileURLToPath(
  new URL('../../../evals/requirements-v0.1.jsonl', import.meta.url),
);
const cassetteDirectory = fileURLToPath(
  new URL('./fixtures/corpus-cassettes/', import.meta.url),
);
const promptPath = fileURLToPath(
  new URL('../prompts/extract.v1.md', import.meta.url),
);

function createContext(
  signal: AbortSignal = new AbortController().signal,
  deadlineMs = Date.now() + 60_000,
): CallContext {
  return {
    requestId: 'extract-test',
    signal,
    deadlineMs,
    tracer: {
      withSpan: async (_name, _opts, fn) =>
        fn({ setAttributes: () => undefined, score: () => undefined }),
      flush: async () => undefined,
    },
  };
}

async function loadDevelopmentCases(): Promise<CorpusCase[]> {
  const contents = await readFile(corpusPath, 'utf8');
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusCase)
    .filter(({ split }) => split === 'development');
}

async function cassetteRequest(query: string): Promise<LlmJsonRequest> {
  return {
    task: 'extract',
    promptVersion: EXTRACTION_PROMPT_VERSION,
    system: await readFile(promptPath, 'utf8'),
    user: query,
    jsonSchema: toJsonSchemas().ExtractedRequirements as object,
    maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  };
}

function normalizeExpected(expected: CorpusCase['expected']) {
  const range =
    expected.time_coverage?.match(
      /\b(?:from\s+|between\s+)?(\d{4})\s*(?:-|–|—|to|through|and)\s*(\d{4})\b/i,
    ) ?? null;
  return {
    ...expected,
    time_coverage: range ? `${range[1]}-${range[2]}` : expected.time_coverage,
  };
}

describe('requirement extraction', () => {
  it('replays schema-valid outputs for all development cases only', async () => {
    const cases = await loadDevelopmentCases();
    const developmentIds = cases.map(({ case_id }) => case_id);
    const fixtureFiles = await readdir(cassetteDirectory);
    const expectedCassetteNames = await Promise.all(
      cases.map(
        async ({ input }) =>
          `${getCassetteKey(await cassetteRequest(input))}.json`,
      ),
    );
    expect(cases).toHaveLength(40);
    expect(developmentIds.every((caseId) => caseId.startsWith('REQE-'))).toBe(
      true,
    );
    // The adversarial safety replay has one extra sanitized-query cassette in
    // addition to the 40 development-corpus fixtures.
    const safetyFixtureNames = [
      'a7f9680ed72aff3ad77265698c85fb50bcc6a02908aee53ed68dede849c891b6.json',
    ];
    expect(fixtureFiles.sort()).toEqual(
      [...expectedCassetteNames, ...safetyFixtureNames].sort(),
    );

    const client = createLlmClient(
      loadLlmConfig({
        LLM_PROVIDER: 'cassette',
        LLM_CASSETTE_DIR: cassetteDirectory,
      }),
    );
    const extractor = createRequirementExtractor(client, () => null);
    for (const testCase of cases) {
      const result = await extractor.extract(testCase.input, createContext());
      const expected = normalizeExpected(testCase.expected);
      if (expected.topic === null) {
        expect(result).toEqual({
          kind: 'clarification',
          question: 'What kind of dataset does your project need?',
        });
        continue;
      }

      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') continue;
      expect(
        ExtractedRequirementsSchema.safeParse(result.requirements).success,
      ).toBe(true);
      expect(result.requirements).toEqual(expected);
      expect(result.promptVersion).toBe(EXTRACTION_PROMPT_VERSION);
      for (const requirement of result.derived) {
        expect(RequirementSchema.safeParse(requirement).success).toBe(true);
        if (requirement.source_span !== null) {
          expect(
            testCase.input.slice(
              requirement.source_span.start,
              requirement.source_span.end,
            ),
          ).toBe(requirement.source_span.text);
        }
        if (
          requirement.type === 'time_coverage' &&
          typeof requirement.value === 'string' &&
          /^\d{4}-\d{4}$/.test(requirement.value)
        ) {
          expect(requirement.source_span?.text).toMatch(/\d{4}\D+\d{4}/);
        }
      }
    }
  });

  it.each(['REQE-001', 'REQE-002', 'REQE-015'])(
    'works with the fake provider for %s',
    async (caseId) => {
      const testCase = (await loadDevelopmentCases()).find(
        (item) => item.case_id === caseId,
      );
      if (!testCase) throw new Error(`Missing development case ${caseId}`);
      const client = createLlmClient(loadLlmConfig({ LLM_PROVIDER: 'fake' }));
      const extractor = createRequirementExtractor(client, () => null);
      const result = await extractor.extract(testCase.input, createContext());
      if (testCase.expected.topic === null) {
        expect(result.kind).toBe('clarification');
        return;
      }
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(
          ExtractedRequirementsSchema.safeParse(result.requirements).success,
        ).toBe(true);
      }
    },
  );

  it.each([
    ['malformed JSON', '{"unexpected":'],
    [
      'extra fields',
      {
        topic: 'topic',
        geography: null,
        time_coverage: null,
        minimum_records: null,
        required_features: [],
        target: null,
        preferences: [],
        constraints: [],
        unexpected: true,
      },
    ],
    [
      'negative count',
      {
        topic: 'topic',
        geography: null,
        time_coverage: null,
        minimum_records: -1,
        required_features: [],
        target: null,
        preferences: [],
        constraints: [],
      },
    ],
    [
      'fractional count',
      {
        topic: 'topic',
        geography: null,
        time_coverage: null,
        minimum_records: 1.5,
        required_features: [],
        target: null,
        preferences: [],
        constraints: [],
      },
    ],
    [
      'overlong scalar',
      {
        topic: 'x'.repeat(201),
        geography: null,
        time_coverage: null,
        minimum_records: null,
        required_features: [],
        target: null,
        preferences: [],
        constraints: [],
      },
    ],
    [
      'overlong list item',
      {
        topic: 'topic',
        geography: null,
        time_coverage: null,
        minimum_records: null,
        required_features: ['x'.repeat(101)],
        target: null,
        preferences: [],
        constraints: [],
      },
    ],
  ])('retries %s once, then returns a safe error', async (_label, output) => {
    const generateJson = vi.fn(async (): Promise<LlmJsonResponse> => ({
      output,
      modelId: 'malformed-test',
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    }));
    const client: LlmClient = {
      provider: 'fake',
      modelId: 'malformed-test',
      generateJson,
    };
    const extractor = createRequirementExtractor(client, () => null);
    const testCase = (await loadDevelopmentCases())[0]!;

    await expect(
      extractor.extract(testCase.input, createContext()),
    ).rejects.toMatchObject({
      code: 'extraction_failed',
      safeMessage: 'The requirement extractor returned invalid output.',
    });
    expect(generateJson).toHaveBeenCalledTimes(2);
  });

  it('returns refusal before a model call when the safety check rejects', async () => {
    const generateJson = vi.fn(async (): Promise<LlmJsonResponse> => {
      throw new Error('model must not be called');
    });
    const client: LlmClient = {
      provider: 'fake',
      modelId: 'test',
      generateJson,
    };
    const extractor = createRequirementExtractor(
      client,
      () => 'unsafe_request',
    );

    await expect(
      extractor.extract('request with restricted data', createContext()),
    ).resolves.toEqual({
      kind: 'refused',
      reasonCode: createRefusal('unsafe_request').reason_code,
    });
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('preserves caller cancellation and expired deadlines', async () => {
    const safetyCheck = vi.fn(() => null);
    const client = createLlmClient(loadLlmConfig({ LLM_PROVIDER: 'fake' }));
    const extractor = createRequirementExtractor(client, safetyCheck);
    const controller = new AbortController();
    controller.abort();
    const knownQuery =
      'Find crop yield data for Maharashtra with rainfall and temperature fields.';

    await expect(
      extractor.extract(knownQuery, createContext(controller.signal)),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      extractor.extract(
        knownQuery,
        createContext(new AbortController().signal, Date.now() - 1),
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(safetyCheck).not.toHaveBeenCalled();
  });

  it('retries a provider timeout once and preserves the final timeout', async () => {
    const generateJson = vi.fn(async (): Promise<LlmJsonResponse> => {
      throw new DataScoutError('timeout', 'The LLM request timed out.');
    });
    const client: LlmClient = {
      provider: 'fake',
      modelId: 'test',
      generateJson,
    };
    const extractor = createRequirementExtractor(client, () => null);
    const query =
      'Find crop yield data for Maharashtra with rainfall and temperature fields.';

    await expect(
      extractor.extract(query, createContext()),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(generateJson).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid queries before invoking safety or the model', async () => {
    const safetyCheck = vi.fn(() => null);
    const generateJson = vi.fn();
    const client: LlmClient = {
      provider: 'fake',
      modelId: 'test',
      generateJson,
    };
    const extractor = createRequirementExtractor(client, safetyCheck);

    await expect(
      extractor.extract('  ', createContext()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      extractor.extract('x'.repeat(1_001), createContext()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(safetyCheck).not.toHaveBeenCalled();
    expect(generateJson).not.toHaveBeenCalled();
  });
});
