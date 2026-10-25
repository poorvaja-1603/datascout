import { DeadlineExceededError, sanitizeHeaderNames } from './csv.js';
import type { InspectionLimits, ParsedTable } from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function toSafeRowObject(
  rawItem: unknown,
  allowedHeaders: string[],
): Record<string, unknown> | null {
  if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
    return null;
  }

  const safeRow: Record<string, unknown> = Object.create(null);
  const rawRecord = rawItem as Record<string, unknown>;

  for (const header of allowedHeaders) {
    if (FORBIDDEN_KEYS.has(header)) {
      continue;
    }
    const val = rawRecord[header];
    safeRow[header] = val !== undefined ? val : null;
  }

  return safeRow;
}

export function parseJson(
  text: string,
  limits: InspectionLimits,
  deadlineMs?: number,
  signal?: AbortSignal,
): ParsedTable {
  const trimmed = text.trim();
  let rawItems: unknown[] = [];
  let truncated = false;

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        rawItems = parsed;
      } else {
        return {
          columns: [],
          rows: [],
          totalRowsEncountered: 0,
          truncated: false,
          dateParseSuccessCount: 0,
          dateRange: null,
        };
      }
    } catch {
      // Truncated JSON array handling: return typed empty table marked as truncated
      // rather than throwing unhandled syntax error
      return {
        columns: [],
        rows: [],
        totalRowsEncountered: 0,
        truncated: true,
        truncationReason: 'Malformed or truncated JSON array payload',
        dateParseSuccessCount: 0,
        dateRange: null,
      };
    }
  } else {
    // Attempt parsing as JSON Lines (NDJSON) or single object
    const lines = trimmed.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (i % 20 === 0) {
        if (signal?.aborted || (deadlineMs !== undefined && Date.now() > deadlineMs)) {
          throw new DeadlineExceededError();
        }
      }

      const line = lines[i]!.trim();
      if (line.length === 0) continue;

      try {
        const item = JSON.parse(line);
        rawItems.push(item);
      } catch {
        // Drop partial/malformed trailing line in NDJSON
        if (i === lines.length - 1) {
          truncated = true;
          break;
        }
      }
    }
  }

  // Discover columns across rows (preserving order of appearance)
  const discoveredKeys: string[] = [];
  const seenKeys = new Set<string>();

  for (let r = 0; r < Math.min(rawItems.length, limits.maxRows); r++) {
    const item = rawItems[r];
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      for (const key of Object.keys(item)) {
        if (!FORBIDDEN_KEYS.has(key) && !seenKeys.has(key)) {
          seenKeys.add(key);
          discoveredKeys.push(key);
        }
      }
    }
  }

  const { headers, truncated: headerTruncated } = sanitizeHeaderNames(
    discoveredKeys,
    limits.maxColumns,
  );

  const totalEncountered = rawItems.length;
  const rows: Array<Record<string, unknown>> = [];
  let rowTruncated = false;

  for (let i = 0; i < rawItems.length; i++) {
    if (i % 20 === 0) {
      if (signal?.aborted || (deadlineMs !== undefined && Date.now() > deadlineMs)) {
        throw new DeadlineExceededError();
      }
    }

    if (rows.length >= limits.maxRows) {
      rowTruncated = true;
      break;
    }

    const safeRow = toSafeRowObject(rawItems[i], headers);
    if (safeRow !== null) {
      rows.push(safeRow);
    }
  }

  return {
    columns: headers,
    rows,
    totalRowsEncountered: totalEncountered,
    truncated: truncated || rowTruncated || headerTruncated,
    truncationReason: rowTruncated
      ? `Truncated to ${limits.maxRows} rows`
      : undefined,
    dateParseSuccessCount: 0,
    dateRange: null,
  };
}
