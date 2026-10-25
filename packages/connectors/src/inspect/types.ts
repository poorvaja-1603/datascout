import type {
  CallContext,
  Dataset,
  InspectionLimits,
  SampleInspection,
} from '@datascout/contracts';

export type { InspectionLimits };

export const DEFAULT_INSPECTION_LIMITS: InspectionLimits = {
  maxBytes: 5 * 1024 * 1024, // 5 MB
  maxRows: 1000,
  maxColumns: 100,
  timeoutMs: 5000,
};

export interface SampleFetchResult {
  bytes: Uint8Array;
  contentType?: string | undefined;
  filename?: string | undefined;
}

export interface SampleFetcher {
  fetchSample(
    dataset: Dataset,
    limits: InspectionLimits,
    ctx: CallContext,
  ): Promise<SampleFetchResult | null>;
}

export interface InspectBytesOptions {
  contentType?: string | undefined;
  filename?: string | undefined;
  limits?: Partial<InspectionLimits> | undefined;
  deadlineMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ParsedTable {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  totalRowsEncountered: number;
  truncated: boolean;
  truncationReason?: string | undefined;
  dateParseSuccessCount: number;
  dateRange: { start: string; end: string } | null;
}

export type InspectionStatus = SampleInspection['status'];
