import type { Evidence, SampleInspection } from '@datascout/contracts';
import type { ParsedTable } from './types.js';

// Unambiguous dates only: YYYY-MM-DD or full ISO 8601 datetime
const UNAMBIGUOUS_ISO_DATE_REGEX =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isUnambiguousIsoDate(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!UNAMBIGUOUS_ISO_DATE_REGEX.test(trimmed)) return null;

  const parsed = new Date(trimmed);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function isMissing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim().length === 0) return true;
  return false;
}

function inferTypeForValues(values: unknown[]): string {
  const nonMissing = values.filter((v) => !isMissing(v));
  if (nonMissing.length === 0) return 'string';

  let allBoolean = true;
  let allInteger = true;
  let allNumeric = true;
  let allDate = true;

  for (const v of nonMissing) {
    // Check boolean
    if (typeof v === 'boolean' || v === 'true' || v === 'false') {
      // boolean match
    } else {
      allBoolean = false;
    }

    // Check date
    if (!isUnambiguousIsoDate(v)) {
      allDate = false;
    }

    // Check numeric
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (!Number.isInteger(v)) {
        allInteger = false;
      }
    } else if (
      typeof v === 'string' &&
      v.trim().length > 0 &&
      !isNaN(Number(v)) &&
      Number.isFinite(Number(v))
    ) {
      if (!Number.isInteger(Number(v))) {
        allInteger = false;
      }
    } else {
      allNumeric = false;
      allInteger = false;
    }
  }

  if (allBoolean) return 'boolean';
  if (allInteger) return 'integer';
  if (allNumeric) return 'number';
  if (allDate) return 'date';
  return 'string';
}

export function computeInspectionMetrics(
  table: ParsedTable,
  datasetId: string,
  now = new Date().toISOString(),
): {
  columns: SampleInspection['columns'];
  dateRange: SampleInspection['dateRange'];
  dateParseSuccessCount: number;
  duplicateRate: number | null;
  evidence: Evidence[];
} {
  const rowCount = table.rows.length;
  if (rowCount === 0) {
    return {
      columns: table.columns.map((name) => ({
        name,
        inferredType: 'string',
        missingRate: null,
      })),
      dateRange: null,
      dateParseSuccessCount: 0,
      duplicateRate: null,
      evidence: [],
    };
  }

  // 1. Column inferred types & missingness rates
  const columns: SampleInspection['columns'] = [];
  let minDate: string | null = null;
  let maxDate: string | null = null;
  let dateParseSuccessCount = 0;

  for (const colName of table.columns) {
    const colValues = table.rows.map((row) => row[colName]);
    const missingCount = colValues.filter(isMissing).length;
    const missingRate = Math.round((missingCount / rowCount) * 1000) / 1000;
    const inferredType = inferTypeForValues(colValues);

    columns.push({
      name: colName,
      inferredType,
      missingRate,
    });

    // Extract date ranges from date-like columns
    if (inferredType === 'date') {
      for (const val of colValues) {
        const iso = isUnambiguousIsoDate(val);
        if (iso !== null) {
          dateParseSuccessCount++;
          if (minDate === null || iso < minDate) minDate = iso;
          if (maxDate === null || iso > maxDate) maxDate = iso;
        }
      }
    }
  }

  // 2. Duplicate rows rate
  const seenRowHashes = new Set<string>();
  let duplicateCount = 0;

  for (const row of table.rows) {
    // Deterministic row fingerprint
    const fingerprint = table.columns.map((col) => String(row[col])).join('\x1F');
    if (seenRowHashes.has(fingerprint)) {
      duplicateCount++;
    } else {
      seenRowHashes.add(fingerprint);
    }
  }

  const duplicateRate =
    rowCount > 0 ? Math.round((duplicateCount / rowCount) * 1000) / 1000 : 0;

  const dateRange =
    minDate !== null && maxDate !== null ? { start: minDate, end: maxDate } : null;

  // 3. Evidence generation strictly matching packages/verify consumed fields:
  // 'columns', 'record_count', 'time_coverage'
  const evidence: Evidence[] = [];

  if (columns.length > 0) {
    evidence.push({
      evidence_id: `evidence-columns-${datasetId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      dataset_id: datasetId,
      field: 'columns',
      value: columns.map((c) => c.name),
      provenance: {
        source_field_path: 'sample.header',
        retrieved_at: now,
      },
    });
  }

  evidence.push({
    evidence_id: `evidence-records-${datasetId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    dataset_id: datasetId,
    field: 'record_count',
    value: rowCount,
    provenance: {
      source_field_path: 'sample.rows',
      retrieved_at: now,
    },
  });

  if (dateRange !== null) {
    evidence.push({
      evidence_id: `evidence-time-${datasetId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      dataset_id: datasetId,
      field: 'time_coverage',
      value: `${dateRange.start}..${dateRange.end}`,
      provenance: {
        source_field_path: 'sample.dates',
        retrieved_at: now,
      },
    });
  }

  return {
    columns,
    dateRange,
    dateParseSuccessCount,
    duplicateRate,
    evidence,
  };
}
