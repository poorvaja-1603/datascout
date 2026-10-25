import type {
  CallContext,
  Dataset,
  InspectionLimits,
  Inspector,
  SampleInspection,
} from '@datascout/contracts';
import { safeFetch } from '../toolkit/safe-fetch.js';
import { DeadlineExceededError, parseCsv } from './csv.js';
import { sniffFormat } from './detector.js';
import { parseJson } from './json.js';
import { computeInspectionMetrics } from './metrics.js';
import { parseParquet } from './parquet.js';
import {
  DEFAULT_INSPECTION_LIMITS,
  type InspectBytesOptions,
  type ParsedTable,
  type SampleFetcher,
  type SampleFetchResult,
} from './types.js';

export class DefaultSampleFetcher implements SampleFetcher {
  async fetchSample(
    dataset: Dataset,
    limits: InspectionLimits,
    ctx: CallContext,
  ): Promise<SampleFetchResult | null> {
    const targetUrl = dataset.api_endpoint ?? dataset.source_url;
    if (!targetUrl) return null;

    try {
      const response = await safeFetch(targetUrl, {
        signal: ctx.signal,
        timeoutMs: limits.timeoutMs,
        maxBytes: limits.maxBytes,
      });

      if (response.status !== 200) {
        return null;
      }

      const bytes = await response.bytes();
      const contentType = response.headers.get('content-type') ?? undefined;

      return {
        bytes,
        contentType,
        filename: targetUrl.split('/').pop()?.split('?')[0],
      };
    } catch {
      return null;
    }
  }
}

export class BoundedInspector implements Inspector {
  constructor(private readonly fetcher?: SampleFetcher) {}

  async inspect(
    dataset: Dataset,
    limits: InspectionLimits,
    ctx: CallContext,
  ): Promise<SampleInspection> {
    if (ctx.signal.aborted) {
      return {
        datasetId: dataset.dataset_id,
        status: 'failed',
        verificationLevel: 'metadata_only',
        rowsExamined: 0,
        columns: [],
        dateRange: null,
        duplicateRate: null,
        evidence: [],
      };
    }

    if (!this.fetcher) {
      return {
        datasetId: dataset.dataset_id,
        status: 'ok',
        verificationLevel: 'metadata_only',
        rowsExamined: 0,
        columns: [],
        dateRange: null,
        duplicateRate: null,
        evidence: [],
      };
    }

    let sampleResult: SampleFetchResult | null;
    try {
      sampleResult = await this.fetcher.fetchSample(dataset, limits, ctx);
    } catch {
      return {
        datasetId: dataset.dataset_id,
        status: 'failed',
        verificationLevel: 'metadata_only',
        rowsExamined: 0,
        columns: [],
        dateRange: null,
        duplicateRate: null,
        evidence: [],
      };
    }

    if (!sampleResult || sampleResult.bytes.length === 0) {
      return {
        datasetId: dataset.dataset_id,
        status: 'failed',
        verificationLevel: 'metadata_only',
        rowsExamined: 0,
        columns: [],
        dateRange: null,
        duplicateRate: null,
        evidence: [],
      };
    }

    return this.inspectBytes(dataset, sampleResult.bytes, {
      contentType: sampleResult.contentType,
      filename: sampleResult.filename,
      limits,
      deadlineMs: ctx.deadlineMs,
      signal: ctx.signal,
    });
  }

  async inspectBytes(
    dataset: Dataset,
    bytes: Uint8Array,
    options: InspectBytesOptions = {},
  ): Promise<SampleInspection> {
    const limits: InspectionLimits = {
      ...DEFAULT_INSPECTION_LIMITS,
      ...(options.limits ?? {}),
    };

    const emptyResult = (
      status: SampleInspection['status'],
    ): SampleInspection => ({
      datasetId: dataset.dataset_id,
      status,
      verificationLevel: 'metadata_only',
      rowsExamined: 0,
      columns: [],
      dateRange: null,
      duplicateRate: null,
      evidence: [],
    });

    // 1. Enforce maxBytes BEFORE any parse call
    if (bytes.byteLength > limits.maxBytes) {
      return emptyResult('too_large');
    }

    // 2. Early cancellation or expired deadline
    if (
      options.signal?.aborted ||
      (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)
    ) {
      return emptyResult('failed');
    }

    // 3. Sniff format and apply security rejection rules without parsing
    const sniff = sniffFormat(bytes, options.filename, options.contentType);

    if (sniff.kind === 'blocked') {
      return emptyResult('blocked');
    }

    if (sniff.kind === 'unsupported') {
      return emptyResult('unsupported_format');
    }

    // 4. Execute bounded format parsing with cooperative deadline checks
    let table: ParsedTable;
    try {
      if (sniff.kind === 'parquet') {
        table = await parseParquet(
          bytes,
          limits,
          options.deadlineMs,
          options.signal,
        );
      } else if (sniff.kind === 'json' || sniff.kind === 'jsonl') {
        const text = new TextDecoder('utf-8').decode(bytes);
        table = parseJson(
          text,
          limits,
          options.deadlineMs,
          options.signal,
        );
      } else {
        const text = new TextDecoder('utf-8').decode(bytes);
        table = parseCsv(
          text,
          limits,
          options.deadlineMs,
          options.signal,
        );
      }
    } catch (err: unknown) {
      if (err instanceof DeadlineExceededError) {
        // Mid-parse deadline: result is failed, partial rows do NOT give sample_checked
        return emptyResult('failed');
      }

      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('unsupported')) {
        return emptyResult('unsupported_format');
      }

      return emptyResult('failed');
    }

    // If parsing yielded 0 rows or was a truncated array with 0 rows
    if (table.rows.length === 0) {
      return {
        datasetId: dataset.dataset_id,
        status: table.truncated ? 'failed' : 'ok',
        verificationLevel: 'metadata_only',
        rowsExamined: 0,
        columns: table.columns.map((c) => ({
          name: c,
          inferredType: 'string',
          missingRate: null,
        })),
        dateRange: null,
        duplicateRate: null,
        evidence: [],
      };
    }

    // 5. Compute metrics and ground evidence
    const metrics = computeInspectionMetrics(table, dataset.dataset_id);

    return {
      datasetId: dataset.dataset_id,
      status: 'ok',
      verificationLevel: 'sample_checked',
      rowsExamined: table.rows.length,
      columns: metrics.columns,
      dateRange: metrics.dateRange,
      duplicateRate: metrics.duplicateRate,
      evidence: metrics.evidence,
    };
  }
}

export async function inspectBytes(
  dataset: Dataset,
  bytes: Uint8Array,
  options?: InspectBytesOptions,
): Promise<SampleInspection> {
  const inspector = new BoundedInspector();
  return inspector.inspectBytes(dataset, bytes, options);
}
