import type { Dataset, SourceId } from '@datascout/contracts';

export const MAX_TITLE_LENGTH = 300;
export const MAX_DESCRIPTION_LENGTH = 2000;

export interface RawCandidate {
  source: SourceId | string;
  native_id: string;
  source_url?: string | null;
  title?: string | null;
  description?: string | null;
  license?: string | null;
  access_type?: string | null;
  api_endpoint?: string | null;
  file_formats?: string[];
  record_count?: number | null;
  columns?: string[];
  geography?: string | null;
  time_coverage?: string | null;
  tags?: string[];
  last_updated?: string | null;
  raw_snapshot_key?: string | null;
  verification_level?: 'metadata_only' | 'sample_checked' | 'full_dataset';
  field_paths?: Record<string, string>;
  raw_payload?: unknown;
}

export interface NormalizedCandidate {
  dataset: Dataset;
  rawLicense: string | null;
}
