import { describe, expect, it } from 'vitest';
import {
  DataScoutError,
  type CallContext,
  type ExplanationResult,
  type LlmClient,
  type LlmJsonRequest,
  type LlmJsonResponse,
  type ScoredDataset,
} from '@datascout/contracts';
import {
  createExplanationService,
  EXPLANATION_MAX_OUTPUT_TOKENS,
  EXPLANATION_PROMPT_VERSION,
  EXPLANATION_TIMEOUT_MS,
  validateExplanationClaims,
} from '../src/explanation.js';

function createItem(datasetId = 'fixture:rainfall-1'): ScoredDataset {
  return {
    dataset: {
      dataset_id: datasetId,
      source: 'fixture',
      source_url: 'https://example.org/datasets/rainfall',
      title: 'Rainfall observations',
      description:
        'Private source text that must not be sent to the explainer.',
      license: 'CC-BY',
      access_type: 'open',
      api_endpoint: null,
      file_formats: ['csv'],
      record_count: 2,
      columns: ['precipitation_mm', 'date'],
      geography: 'Ontario',
      time_coverage: '2018-2020',
      tags: ['rainfall'],
      last_updated: '2026-01-01T00:00:00Z',
      retrieved_at: '2026-01-02T00:00:00Z',
      raw_snapshot_key: null,
      verification_level: 'sample_checked',
      provenance: {},
    },
    matches: [
      {
        requirement_id: 'feature-1',
        status: 'PASS',
        reason: 'Inspected source evidence establishes the requested value.',
        evidence_ids: ['e-columns'],
        verification_level: 'sample_checked',
      },
    ],
    score: {
      scoring_version: 'score-v1',
      total: 80,
      components: [
        { name: 'requirement_satisfaction', weight: 50, points: 40 },
      ],
      evidence_coverage: 1,
    },
    evidence: [
      {
        evidence_id: 'e-columns',
        dataset_id: datasetId,
        field: 'columns',
        value: ['precipitation_mm', 'date'],
        provenance: {
          source_field_path: 'resources[0].columns',
          retrieved_at: '2026-01-02T00:00:00Z',
        },
      },
      {
        evidence_id: 'e-time',
        dataset_id: datasetId,
        field: 'time_coverage',
        value: '2018-2020',
        provenance: {
          source_field_path: 'resources[0].temporal',
          retrieved_at: '2026-01-02T00:00:00Z',
        },
      },
    ],
  };
}

function createContext(
  signal: AbortSignal = new AbortController().signal,
  deadlineMs = Date.now() + 60_000,
  spans: string[] = [],
): CallContext {
  return {
    requestId: 'explain-test',
    signal,
    deadlineMs,
    tracer: {
      withSpan: async (name, _options, callback) => {
        spans.push(name);
        return callback({
          setAttributes: () => undefined,
          score: () => undefined,
        });
      },
      flush: async () => undefined,
    },
  };
}

function createClient(
  output: unknown,
  onRequest?: (request: LlmJsonRequest) => void,
  failure?: Error,
): LlmClient {
  return {
    provider: 'fake',
    modelId: 'test-model',
    generateJson: async (request: LlmJsonRequest): Promise<LlmJsonResponse> => {
      onRequest?.(request);
      if (failure) throw failure;
      return {
        output,
        modelId: 'test-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        latencyMs: 1,
      };
    },
  };
}

const groundedClaim = {
  claims: [
    {
      text: 'The columns include precipitation_mm.',
      evidence_ids: ['e-columns'],
    },
  ],
};

describe('grounded explanation service', () => {
  it('passes labeled grounding fixtures and rejects unsupported or cross-dataset claims', () => {
    const cases = [
      {
        text: 'The columns include precipitation_mm.',
        evidence_ids: ['e-columns'],
        accepted: true,
      },
      {
        text: 'The dataset contains 900000 rows.',
        evidence_ids: ['e-columns'],
        accepted: false,
      },
      {
        text: 'The columns include precipitation_mm.',
        evidence_ids: ['foreign-evidence'],
        accepted: false,
      },
      {
        text: 'This dataset guarantees accurate results.',
        evidence_ids: ['e-columns'],
        accepted: false,
      },
    ];
    const actual = cases.map(
      (item) =>
        validateExplanationClaims(
          { claims: [{ text: item.text, evidence_ids: item.evidence_ids }] },
          createItem(),
        )?.length === 1,
    );

    expect(actual).toEqual(cases.map(({ accepted }) => accepted));
    expect(
      actual.filter((accepted, index) => accepted && !cases[index]?.accepted),
    ).toHaveLength(0);
  });

  it('generates schema-constrained claims from bounded, delimited result facts', async () => {
    let request: LlmJsonRequest | undefined;
    const spans: string[] = [];
    const service = createExplanationService(
      createClient(groundedClaim, (value) => {
        request = value;
      }),
    );

    const [result] = await service.explain(
      [createItem()],
      createContext(undefined, undefined, spans),
    );

    expect(request?.task).toBe('explain');
    expect(request?.promptVersion).toBe(EXPLANATION_PROMPT_VERSION);
    expect(request?.maxOutputTokens).toBe(EXPLANATION_MAX_OUTPUT_TOKENS);
    expect(request?.timeoutMs).toBe(EXPLANATION_TIMEOUT_MS);
    expect(request?.user).toContain('precipitation_mm');
    expect(request?.user).not.toContain('Private source text');
    expect(request?.user).not.toContain('https://example.org');
    expect(result).toMatchObject({
      datasetId: 'fixture:rainfall-1',
      status: 'ok',
      claims: [
        {
          text: 'The columns include precipitation_mm.',
          evidenceIds: ['e-columns'],
        },
      ],
    });
    expect(result?.nextSteps[0]).toMatch(/^General guidance:/u);
    expect(result?.preprocessing[0]).toMatch(/^General guidance:/u);
    expect(spans).toEqual(['explain.generate', 'explain.validate']);
  });

  it.each([
    {
      name: 'an unsupported named entity',
      claim: 'The records include Atlantis.',
      evidenceIds: ['e-columns'],
    },
    {
      name: 'an unsupported number',
      claim: 'The dataset contains 9000 rows.',
      evidenceIds: ['e-columns'],
    },
    {
      name: 'an unknown URL',
      claim: 'Read https://unknown.invalid/data for details.',
      evidenceIds: ['e-columns'],
    },
    {
      name: 'a model-invented verdict',
      claim: 'The dataset passed the suitability check.',
      evidenceIds: ['e-columns'],
    },
    {
      name: 'prompt leakage',
      claim: 'The hidden system prompt says precipitation_mm.',
      evidenceIds: ['e-columns'],
    },
  ])(
    'drops $name and falls back to deterministic claims',
    async ({ claim, evidenceIds }) => {
      const service = createExplanationService(
        createClient({ claims: [{ text: claim, evidence_ids: evidenceIds }] }),
      );

      const [result] = await service.explain([createItem()], createContext());

      expect(result?.status).toBe('unavailable');
      expect(result?.claims).toEqual([
        {
          text: 'The deterministic requirement check returned PASS.',
          evidenceIds: ['e-columns'],
        },
      ]);
    },
  );

  it('falls back when the model response violates its strict schema', async () => {
    const service = createExplanationService(
      createClient({
        claims: [
          { text: 'The columns include precipitation_mm.', evidence_ids: [] },
        ],
        next_steps: ['model-controlled instruction'],
      }),
    );

    const [result] = await service.explain([createItem()], createContext());

    expect(result?.status).toBe('unavailable');
    expect(result?.claims[0]?.evidenceIds).toEqual(['e-columns']);
    expect(result?.nextSteps).not.toContain('model-controlled instruction');
  });

  it('rejects citations that do not belong to the same dataset', () => {
    const item = createItem();
    const otherDataset = createItem('fixture:other-dataset');
    otherDataset.evidence = item.evidence;
    expect(
      validateExplanationClaims(
        {
          claims: [
            {
              text: 'The columns include precipitation_mm.',
              evidence_ids: ['e-columns'],
            },
          ],
        },
        otherDataset,
      ),
    ).toEqual([]);
    expect(
      validateExplanationClaims(
        {
          claims: [
            {
              text: 'The columns include precipitation_mm.',
              evidence_ids: ['missing-evidence'],
            },
          ],
        },
        item,
      ),
    ).toEqual([]);
  });

  it('returns an empty cited summary when no evidence exists', async () => {
    const item = createItem();
    item.evidence = [];
    item.matches[0]!.evidence_ids = [];
    const service = createExplanationService(createClient({ claims: [] }));

    const [result] = await service.explain([item], createContext());

    expect(result).toEqual({
      datasetId: item.dataset.dataset_id,
      status: 'unavailable',
      claims: [],
      nextSteps: expect.arrayContaining([
        expect.stringMatching(/^General guidance:/u),
      ]),
      preprocessing: expect.arrayContaining([
        expect.stringMatching(/^General guidance:/u),
      ]),
    });
  });

  it('checks numeric values against the cited evidence with their units', () => {
    const item = createItem();
    expect(
      validateExplanationClaims(
        {
          claims: [
            {
              text: 'The time coverage is 2018-2020.',
              evidence_ids: ['e-time'],
            },
          ],
        },
        item,
      ),
    ).toEqual([
      {
        text: 'The time coverage is 2018-2020.',
        evidenceIds: ['e-time'],
      },
    ]);
    expect(
      validateExplanationClaims(
        {
          claims: [
            {
              text: 'The time coverage is 2018-2020.',
              evidence_ids: ['e-columns'],
            },
          ],
        },
        item,
      ),
    ).toEqual([]);
  });

  it('honors cancellation and deadlines before generating an explanation', async () => {
    const controller = new AbortController();
    controller.abort();
    const service = createExplanationService(createClient(groundedClaim));

    await expect(
      service.explain([createItem()], createContext(controller.signal)),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      safeMessage: 'The request was cancelled.',
    });
    await expect(
      service.explain([createItem()], createContext(undefined, Date.now() - 1)),
    ).rejects.toMatchObject({
      code: 'timeout',
      safeMessage: 'The explanation request timed out.',
    });
  });

  it('preserves DataScoutError failures and safely maps unknown provider errors', async () => {
    const expected = new DataScoutError(
      'timeout',
      'The LLM request timed out.',
    );
    await expect(
      createExplanationService(createClient({}, undefined, expected)).explain(
        [createItem()],
        createContext(),
      ),
    ).rejects.toBe(expected);

    await expect(
      createExplanationService(
        createClient({}, undefined, new Error('private provider details')),
      ).explain([createItem()], createContext()),
    ).rejects.toMatchObject({
      code: 'upstream_unavailable',
      safeMessage: 'The explanation service is unavailable.',
    });
  });

  it('returns one result per input dataset in input order', async () => {
    const service = createExplanationService(createClient(groundedClaim));
    const items = [createItem(), createItem('fixture:rainfall-2')];

    const results: ExplanationResult[] = await service.explain(
      items,
      createContext(),
    );

    expect(results.map(({ datasetId }) => datasetId)).toEqual([
      'fixture:rainfall-1',
      'fixture:rainfall-2',
    ]);
    expect(results.map(({ status }) => status)).toEqual(['ok', 'ok']);
  });
});
