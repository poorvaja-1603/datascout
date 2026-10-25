import {
  DATASET_ID_PATTERN,
  DatasetSchema,
  type Dataset,
  type DatasetProvenance,
} from '@datascout/contracts';
import { normalizeLicense } from './license.js';
import { sanitizeDescription, sanitizeTitle } from './sanitize.js';
import type { NormalizedCandidate, RawCandidate } from './types.js';

const DATASET_ID_REGEX = new RegExp(DATASET_ID_PATTERN);

export function validateDatasetId(datasetId: string): void {
  if (!DATASET_ID_REGEX.test(datasetId)) {
    throw new Error(
      `Dataset ID "${datasetId}" does not match required pattern ${DATASET_ID_PATTERN}`,
    );
  }

  const parts = datasetId.split(':');
  if (parts.length !== 2) {
    throw new Error(
      `Dataset ID "${datasetId}" must contain exactly one ":" delimiter`,
    );
  }

  const nativeId = parts[1]!;

  if (nativeId.startsWith('/') || nativeId.endsWith('/')) {
    throw new Error(
      `Dataset native ID "${nativeId}" must not contain leading or trailing slashes`,
    );
  }

  const segments = nativeId.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(
        `Dataset native ID "${nativeId}" contains empty path segments`,
      );
    }
    if (segment === '..' || segment === '.') {
      throw new Error(
        `Dataset native ID "${nativeId}" contains disallowed relative path segment "${segment}"`,
      );
    }
  }
}

function toValidUrl(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

function toValidIsoDatetime(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  const date = new Date(trimmed);
  if (isNaN(date.getTime())) return null;
  return date.toISOString();
}

function toValidRecordCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return null;
}

function toCleanStringList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function normalizeDataset(
  raw: RawCandidate,
  retrievedAt?: string,
): NormalizedCandidate {
  const timestamp =
    toValidIsoDatetime(retrievedAt) ?? new Date().toISOString();

  // 1. Build and strictly validate dataset_id
  const source = raw.source.trim().toLowerCase();
  const nativeId = raw.native_id.trim();
  const datasetId = `${source}:${nativeId}`;

  validateDatasetId(datasetId);

  // 2. Sanitize untrusted text fields (never infer missing fields from them)
  const title = sanitizeTitle(raw.title);
  const description = sanitizeDescription(raw.description);

  // 3. Normalize license (keep raw license in NormalizedCandidate only)
  const rawLicense =
    typeof raw.license === 'string' && raw.license.trim().length > 0
      ? raw.license.trim()
      : null;
  const license = normalizeLicense(rawLicense);

  // 4. Missing fields stay null/empty; never infer from title or description
  const sourceUrl = toValidUrl(raw.source_url);
  const apiEndpoint = toValidUrl(raw.api_endpoint);
  const accessType =
    typeof raw.access_type === 'string' && raw.access_type.trim().length > 0
      ? raw.access_type.trim()
      : null;
  const fileFormats = toCleanStringList(raw.file_formats);
  const recordCount = toValidRecordCount(raw.record_count);
  const columns = toCleanStringList(raw.columns);
  const geography =
    typeof raw.geography === 'string' && raw.geography.trim().length > 0
      ? raw.geography.trim()
      : null;
  const timeCoverage =
    typeof raw.time_coverage === 'string' && raw.time_coverage.trim().length > 0
      ? raw.time_coverage.trim()
      : null;
  const tags = toCleanStringList(raw.tags);
  const lastUpdated = toValidIsoDatetime(raw.last_updated);
  const rawSnapshotKey =
    typeof raw.raw_snapshot_key === 'string' &&
    raw.raw_snapshot_key.trim().length > 0
      ? raw.raw_snapshot_key.trim()
      : null;
  const verificationLevel =
    raw.verification_level === 'sample_checked' ||
    raw.verification_level === 'full_dataset'
      ? raw.verification_level
      : 'metadata_only';

  // 5. Fill per-field provenance strictly conforming to { source_field_path, retrieved_at }
  const fieldPaths = raw.field_paths ?? {};
  const provenance: Record<string, DatasetProvenance> = {};

  if (title !== null) {
    provenance['title'] = {
      source_field_path: fieldPaths['title'] ?? 'title',
      retrieved_at: timestamp,
    };
  }
  if (description !== null) {
    provenance['description'] = {
      source_field_path: fieldPaths['description'] ?? 'description',
      retrieved_at: timestamp,
    };
  }
  if (rawLicense !== null) {
    provenance['license'] = {
      source_field_path: fieldPaths['license'] ?? 'license',
      retrieved_at: timestamp,
    };
  }
  if (sourceUrl !== null) {
    provenance['source_url'] = {
      source_field_path: fieldPaths['source_url'] ?? 'source_url',
      retrieved_at: timestamp,
    };
  }
  if (apiEndpoint !== null) {
    provenance['api_endpoint'] = {
      source_field_path: fieldPaths['api_endpoint'] ?? 'api_endpoint',
      retrieved_at: timestamp,
    };
  }
  if (accessType !== null) {
    provenance['access_type'] = {
      source_field_path: fieldPaths['access_type'] ?? 'access_type',
      retrieved_at: timestamp,
    };
  }
  if (fileFormats.length > 0) {
    provenance['file_formats'] = {
      source_field_path: fieldPaths['file_formats'] ?? 'file_formats',
      retrieved_at: timestamp,
    };
  }
  if (recordCount !== null) {
    provenance['record_count'] = {
      source_field_path: fieldPaths['record_count'] ?? 'record_count',
      retrieved_at: timestamp,
    };
  }
  if (columns.length > 0) {
    provenance['columns'] = {
      source_field_path: fieldPaths['columns'] ?? 'columns',
      retrieved_at: timestamp,
    };
  }
  if (geography !== null) {
    provenance['geography'] = {
      source_field_path: fieldPaths['geography'] ?? 'geography',
      retrieved_at: timestamp,
    };
  }
  if (timeCoverage !== null) {
    provenance['time_coverage'] = {
      source_field_path: fieldPaths['time_coverage'] ?? 'time_coverage',
      retrieved_at: timestamp,
    };
  }
  if (tags.length > 0) {
    provenance['tags'] = {
      source_field_path: fieldPaths['tags'] ?? 'tags',
      retrieved_at: timestamp,
    };
  }
  if (lastUpdated !== null) {
    provenance['last_updated'] = {
      source_field_path: fieldPaths['last_updated'] ?? 'last_updated',
      retrieved_at: timestamp,
    };
  }

  const datasetCandidate: Dataset = {
    dataset_id: datasetId,
    source,
    source_url: sourceUrl,
    title,
    description,
    license,
    access_type: accessType,
    api_endpoint: apiEndpoint,
    file_formats: fileFormats,
    record_count: recordCount,
    columns,
    geography,
    time_coverage: timeCoverage,
    tags,
    last_updated: lastUpdated,
    retrieved_at: timestamp,
    raw_snapshot_key: rawSnapshotKey,
    verification_level: verificationLevel,
    provenance,
  };

  // Validate strictly against DatasetSchema
  const dataset = DatasetSchema.parse(datasetCandidate);

  return {
    dataset,
    rawLicense,
  };
}
