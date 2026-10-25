import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ExtractedRequirements, ExtractionResult } from '@datascout/contracts';
import {
  evaluate,
  parseArgs,
  parseCorpus,
  REPORT_SCHEMA_VERSION,
  type CorpusCase,
} from './runner.js';
import { appendModelEvaluation, appendStructuralReplay } from './update-baseline.js';
import { evaluateModel } from './model-runner.js';

const corpusPath = fileURLToPath(
  new URL('./requirements-v0.1.jsonl', import.meta.url),
);

function expectedFields(
  overrides: Partial<ExtractedRequirements> = {},
): ExtractedRequirements {
  return {
    topic: null,
    geography: null,
    time_coverage: null,
    minimum_records: null,
    required_features: [],
    target: null,
    preferences: [],
    constraints: [],
    ...overrides,
  };
}

function caseRow(
  caseId: string,
  split: CorpusCase['split'],
  expected = expectedFields(),
): CorpusCase {
  return {
    case_id: caseId,
    split,
    input: `Case ${caseId}`,
    categories: [],
    expected,
  };
}

const noRequirements: ExtractionResult = {
  kind: 'ok' as const,
  requirements: expectedFields(),
  derived: [],
  promptVersion: 'test-prompt',
  modelId: 'test-model',
};

describe('extraction evaluation runner', () => {
  it('defaults to development and the deterministic cassette provider', () => {
    const parsed = parseArgs([]);
    expect('help' in parsed).toBe(false);
    if ('help' in parsed) return;
    expect(parsed.split).toBe('development');
    expect(parsed.provider).toBe('cassette');
  });

  it('publishes the versioned report schema with every extraction field', async () => {
    const schema = JSON.parse(
      await readFile(new URL('./report.schema.json', import.meta.url), 'utf8'),
    ) as {
      properties: {
        report_schema: { const: string };
        metrics: {
          properties: {
            per_field: { properties: Record<string, unknown> };
            [key: string]: unknown;
          };
        };
      };
    };
    expect(schema.properties.report_schema.const).toBe(REPORT_SCHEMA_VERSION);
    expect(Object.keys(schema.properties.metrics.properties.per_field.properties).sort()).toEqual(
      [
        'topic',
        'geography',
        'time_coverage',
        'minimum_records',
        'required_features',
        'target',
        'preferences',
        'constraints',
      ].sort(),
    );
    expect(Object.keys(schema.properties.metrics.properties).sort()).toContain('safety');
  });

  it('fails the evaluation when an adversarially labelled case is not mitigated', async () => {
    const row = {
      ...caseRow('missed-attack', 'development'),
      input: 'Find crop yield data for India with rainfall.',
      categories: ['adversarial'],
    };
    await expect(evaluate({
      corpusText: JSON.stringify(row),
      provider: 'fake',
      extract: async () => noRequirements,
    })).rejects.toThrow('Safety preflight assertion failed for missed-attack');
  });

  it('requires a separate cassette directory for explicit held-out cassette replay', () => {
    expect(() => parseArgs(['--heldout'])).toThrow(
      'requires a separate --cassette-dir',
    );
    const explicit = parseArgs([
      '--heldout',
      '--provider',
      'cassette',
      '--cassette-dir',
      'evals/held-out-cassettes',
    ]);
    expect('help' in explicit ? false : explicit.split === 'held_out').toBe(
      true,
    );
    const fake = parseArgs(['--heldout', '--provider', 'fake']);
    expect('help' in fake ? false : fake.provider === 'fake').toBe(true);
  });

  it('rejects the development cassette directory for held-out evaluation', async () => {
    const corpusText = JSON.stringify(caseRow('held', 'held_out'));
    const developmentCassettes = fileURLToPath(
      new URL('../packages/ai/test/fixtures/corpus-cassettes/', import.meta.url),
    );
    await expect(
      evaluate({
        corpusText,
        split: 'held_out',
        provider: 'cassette',
        cassetteDirectory: developmentCassettes,
      }),
    ).rejects.toThrow(
      'Held-out cassette runs cannot use the development cassette directory.',
    );
  });

  it('records the run start time before extraction begins', async () => {
    const start = new Date('2026-10-24T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      const reportPromise = evaluate({
        corpusText: JSON.stringify(caseRow('dev', 'development')),
        provider: 'fake',
        extract: async () => {
          vi.setSystemTime(new Date(start.getTime() + 60_000));
          return noRequirements;
        },
      });
      const report = await reportPromise;
      expect(report.run.started_at).toBe(start.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('only sends the selected default development inputs to the extractor', async () => {
    const corpusText = await readFile(corpusPath, 'utf8');
    const sentInputs: string[] = [];
    const report = await evaluate({
      corpusText,
      provider: 'fake',
      extract: async (input) => {
        sentInputs.push(input);
        return noRequirements;
      },
      now: new Date('2026-10-24T00:00:00.000Z'),
    });
    expect(report.run.split).toBe('development');
    expect(report.run.case_count).toBe(40);
    expect(sentInputs).toHaveLength(40);
    expect(report.evaluation_kind).toBe('structural_fixture_replay_with_safety_preflight');
    expect(report.quality_claim).toBe('none_structural_replay_only');
    expect(report.run.corpus_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('runs held-out inputs only when the caller explicitly selects that split', async () => {
    const development = caseRow('dev', 'development');
    const heldOutA = caseRow('held-a', 'held_out');
    const heldOutB = caseRow('held-b', 'held_out');
    const corpusText = [development, heldOutA, heldOutB]
      .map((row) => JSON.stringify(row))
      .join('\n');
    const defaultInputs: string[] = [];
    const heldOutInputs: string[] = [];
    await evaluate({
      corpusText,
      provider: 'fake',
      extract: async (input) => {
        defaultInputs.push(input);
        return noRequirements;
      },
    });
    const heldOutReport = await evaluate({
      corpusText,
      split: 'held_out',
      provider: 'fake',
      extract: async (input) => {
        heldOutInputs.push(input);
        return noRequirements;
      },
    });
    expect(defaultInputs).toEqual(['Case dev']);
    expect(heldOutInputs).toEqual(['Case held-a', 'Case held-b']);
    expect(heldOutReport.run.split).toBe('held_out');
  });

  it('uses only conservative exact field matches with normalized explicit year ranges', async () => {
    const row = caseRow(
      'year-range',
      'development',
      expectedFields({
        topic: 'rainfall',
        time_coverage: '2018 to 2023',
        required_features: ['rainfall', 'temperature'],
      }),
    );
    const report = await evaluate({
      corpusText: JSON.stringify(row),
      provider: 'fake',
      extract: async () => ({
        kind: 'ok',
        requirements: expectedFields({
          topic: 'rainfall',
          time_coverage: '2018-2023',
          required_features: ['temperature', 'rainfall'],
        }),
        derived: [],
        promptVersion: 'test-prompt',
        modelId: 'test-model',
      }),
    });
    expect(report.metrics.per_field.topic.exact_match_rate).toBe(1);
    expect(report.metrics.per_field.time_coverage.exact_match_rate).toBe(1);
    expect(report.metrics.per_field.required_features.exact_match_rate).toBe(0);
    expect(report.metrics.all_fields_exact_match_rate).toBe(0);
  });

  it('scores clarification as empty fields but does not treat a refusal as extracted fields', async () => {
    const row = caseRow('ambiguous', 'development');
    const clarification = await evaluate({
      corpusText: JSON.stringify(row),
      provider: 'fake',
      extract: async () => ({
        kind: 'clarification',
        question: 'What topic should the dataset cover?',
      }),
    });
    expect(clarification.metrics.all_fields_exact_match_rate).toBe(1);

    const refusal = await evaluate({
      corpusText: JSON.stringify(row),
      provider: 'fake',
      extract: async () => ({ kind: 'refused', reasonCode: 'unsafe_request' }),
    });
    expect(refusal.metrics.all_fields_exact_match_rate).toBe(0);
  });

  it('replays the real A2 cassette extractor on all 40 development cases without claiming quality', async () => {
    const corpusText = await readFile(corpusPath, 'utf8');
    const report = await evaluate({ corpusText });
    expect(report.run.case_count).toBe(40);
    expect(report.run.provider).toBe('cassette');
    expect(report.run.model_id).toBe('development-gold-fixture-v0.1');
    expect(report.run.prompt_version).toBe('extract-v1');
    expect(report.run.safety_check).toBe('evaluation_allow_all');
    expect(report.metrics.all_fields_exact_match_cases).toBe(40);
    expect(report.metrics.all_fields_exact_match_rate).toBe(1);
    expect(
      report.cases.find(({ case_id }) => case_id === 'REQE-015')?.result_kind,
    ).toBe('clarification');
    expect(report.quality_claim).toBe('none_structural_replay_only');
  });

  it('does not emit a model baseline without opt-in and preserves NOT RUN after structural opt-in', async () => {
    const report = await evaluate({
      corpusText: JSON.stringify(caseRow('dev', 'development')),
      provider: 'fake',
      extract: async () => noRequirements,
    });
    const baseline = '# Baseline\n\n**Status: NOT RUN.**\n';
    expect(() => appendStructuralReplay(baseline, report, false)).toThrow(
      '--accept-structural-replay',
    );
    const updated = appendStructuralReplay(baseline, report, true);
    expect(updated).toContain('**Status: NOT RUN.**');
    expect(updated).toContain('not model accuracy');
    expect(updated).toContain('Run ID:');
  });

  it('refuses to append held-out results to the baseline even with opt-in', async () => {
    const report = await evaluate({
      corpusText: JSON.stringify(caseRow('held', 'held_out')),
      split: 'held_out',
      provider: 'fake',
      extract: async () => noRequirements,
    });
    expect(() => appendStructuralReplay('# Baseline', report, true)).toThrow(
      'development-only structural replay',
    );
  });

  it('refuses baseline reports whose summary metrics disagree with case results', async () => {
    const report = await evaluate({
      corpusText: JSON.stringify(caseRow('dev', 'development')),
      provider: 'fake',
      extract: async () => noRequirements,
    });
    report.metrics.per_field.topic.exact_matches += 1;
    expect(() => appendStructuralReplay('# Baseline', report, true)).toThrow(
      'metrics do not match',
    );
  });

  it('records only verified development model reports and keeps held-out pending', async () => {
    const corpusText = JSON.stringify(caseRow('dev', 'development'));
    const report = await evaluateModel({
      corpusText,
      modelId: 'qwen3:8b',
      timeoutMs: 120_000,
      extract: async () => noRequirements,
    });
    const baseline = [
      '# Baseline',
      '',
      '**Status: NOT RUN.**',
      '',
      'The v1 requirement contract and extraction implementation exist. No live model-quality baseline has been measured.',
      '',
      '| Measure | Status | Evidence needed |',
      '| --- | --- | --- |',
      '| Requirement extraction accuracy | Not run | Predictions needed |',
    ].join('\n');
    const updated = appendModelEvaluation(baseline, report, 'evals/reports/model.json');
    expect(updated).toContain('DEVELOPMENT BASELINE RECORDED; HELD-OUT NOT RUN');
    expect(updated).toContain('Development measured; held-out not run');
    expect(updated).toContain('held-out quality and release gates remain unrun');

    const heldOut = await evaluateModel({
      corpusText: JSON.stringify(caseRow('held', 'held_out')),
      split: 'held_out',
      modelId: 'qwen3:8b',
      timeoutMs: 120_000,
      extract: async () => noRequirements,
    });
    expect(() => appendModelEvaluation(baseline, heldOut, 'held.json')).toThrow(
      'development-only Ollama model evaluation',
    );
  });

  it('filters splits after parsing corpus rows without changing the parsed split labels', () => {
    const parsed = parseCorpus(
      [
        caseRow('dev', 'development'),
        caseRow('held', 'held_out'),
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );
    expect(parsed.map((row) => row.split)).toEqual([
      'development',
      'held_out',
    ]);
  });
});
