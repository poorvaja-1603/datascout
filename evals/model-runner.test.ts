import { describe, expect, it } from 'vitest';
import type { ExtractionResult, ExtractedRequirements } from '@datascout/contracts';
import { evaluateModel } from './model-runner.js';

const emptyRequirements: ExtractedRequirements = {
  topic: null,
  geography: null,
  time_coverage: null,
  minimum_records: null,
  required_features: [],
  target: null,
  preferences: [],
  constraints: [],
};

function row(caseId: string, split: 'development' | 'held_out', input: string): string {
  return JSON.stringify({
    case_id: caseId,
    split,
    input,
    expected: emptyRequirements,
  });
}

describe('local model evaluation runner', () => {
  it('defaults to development, scores clarification as empty, and omits raw inputs', async () => {
    const inputs: string[] = [];
    const corpusText = [
      row('dev-case', 'development', 'Find data for my project.'),
      row('held-case', 'held_out', 'Held out text must not run.'),
    ].join('\n');
    const report = await evaluateModel({
      corpusText,
      modelId: 'qwen3:8b',
      timeoutMs: 120_000,
      extract: async (input) => {
        inputs.push(input);
        return { kind: 'clarification', question: 'What topic?' };
      },
      now: new Date('2026-10-25T00:00:00.000Z'),
    });

    expect(inputs).toEqual(['Find data for my project.']);
    expect(report.run.split).toBe('development');
    expect(report.metrics.all_fields_exact_match_rate).toBe(1);
    expect(report.metrics.result_kinds.clarification).toBe(1);
    expect(JSON.stringify(report)).not.toContain('Find data for my project.');
    expect(JSON.stringify(report)).not.toContain('Held out text must not run.');
  });

  it('counts refusals as no extraction and records provider errors without raw messages', async () => {
    const corpusText = [
      row('refused-case', 'development', 'unsafe request'),
      row('error-case', 'development', 'normal request'),
    ].join('\n');
    let call = 0;
    const report = await evaluateModel({
      corpusText,
      modelId: 'qwen3:8b',
      timeoutMs: 120_000,
      extract: async (): Promise<ExtractionResult> => {
        call += 1;
        if (call === 1) return { kind: 'refused', reasonCode: 'unsafe_request' };
        throw Object.assign(new Error('do not expose this message'), { code: 'timeout' });
      },
    });

    expect(report.metrics.result_kinds).toMatchObject({ refused: 1, error: 1 });
    expect(report.metrics.all_fields_exact_match_rate).toBe(0);
    expect(report.metrics.per_field.topic.exact_match_rate).toBe(0);
    expect(report.metrics.per_field.minimum_records.exact_match_rate).toBe(0);
    expect(report.cases[1]?.error_code).toBe('timeout');
    expect(JSON.stringify(report)).not.toContain('do not expose this message');
  });
});
