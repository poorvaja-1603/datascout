import { sanitizeText } from '../normalize/index.js';
import type { InspectionLimits, ParsedTable } from './types.js';

export class DeadlineExceededError extends Error {
  constructor(message = 'Inspection deadline exceeded') {
    super(message);
    this.name = 'DeadlineExceededError';
  }
}

export function sanitizeHeaderNames(
  rawHeaders: string[],
  maxColumns: number,
): { headers: string[]; truncated: boolean } {
  let truncated = false;
  let headersToProcess = rawHeaders;

  if (headersToProcess.length > maxColumns) {
    headersToProcess = headersToProcess.slice(0, maxColumns);
    truncated = true;
  }

  const seen = new Set<string>();
  const sanitized: string[] = [];

  for (let i = 0; i < headersToProcess.length; i++) {
    const raw = headersToProcess[i] ?? '';
    const cleaned = sanitizeText(raw, 100);
    const fallbackName = `column_${i + 1}`;

    let finalName = cleaned ?? fallbackName;

    // Handle duplicate header names
    if (seen.has(finalName)) {
      let suffix = 2;
      while (seen.has(`${finalName}_${suffix}`)) {
        suffix++;
      }
      finalName = `${finalName}_${suffix}`;
    }

    seen.add(finalName);
    sanitized.push(finalName);
  }

  return { headers: sanitized, truncated };
}

export function parseCsv(
  text: string,
  limits: InspectionLimits,
  deadlineMs?: number,
  signal?: AbortSignal,
): ParsedTable {
  // Strip BOM if present
  const input = text.startsWith('\uFEFF') ? text.slice(1) : text;

  // Split lines while honoring quotes (RFC 4180)
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  const len = input.length;
  let linesParsed = 0;
  let reachedMaxRows = false;
  let droppedPartialLine = false;

  while (i < len) {
    // Cooperative deadline and cancellation check
    if (linesParsed % 20 === 0) {
      if (
        signal?.aborted ||
        (deadlineMs !== undefined && Date.now() > deadlineMs)
      ) {
        throw new DeadlineExceededError();
      }
    }

    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && input[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
        i++;
        continue;
      } else if (char === '\r') {
        // Handle \r\n or \r
        currentRow.push(currentField);
        currentField = '';
        if (i + 1 < len && input[i + 1] === '\n') {
          i += 2;
        } else {
          i++;
        }
        rows.push(currentRow);
        currentRow = [];
        linesParsed++;

        if (rows.length > limits.maxRows) {
          reachedMaxRows = true;
          break;
        }
        continue;
      } else if (char === '\n') {
        currentRow.push(currentField);
        currentField = '';
        i++;
        rows.push(currentRow);
        currentRow = [];
        linesParsed++;

        if (rows.length > limits.maxRows) {
          reachedMaxRows = true;
          break;
        }
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  // Handle EOF
  if (inQuotes) {
    // Unclosed quote at EOF means the final line was truncated mid-parse
    droppedPartialLine = true;
  } else if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length === 0) {
    return {
      columns: [],
      rows: [],
      totalRowsEncountered: 0,
      truncated: droppedPartialLine,
      dateParseSuccessCount: 0,
      dateRange: null,
    };
  }

  // First row is the header
  const rawHeaders = rows[0]!;
  const { headers, truncated: headerTruncated } = sanitizeHeaderNames(
    rawHeaders,
    limits.maxColumns,
  );

  const dataRowList: Array<Record<string, unknown>> = [];
  const expectedColumnCount = headers.length;
  const totalDataRows = rows.length - 1;

  for (let r = 1; r < rows.length; r++) {
    if (r > limits.maxRows) {
      reachedMaxRows = true;
      break;
    }

    const rowCells = rows[r]!;

    // Check for truncated/ragged final line
    if (
      r === rows.length - 1 &&
      rowCells.length < expectedColumnCount &&
      droppedPartialLine
    ) {
      // Drop partial last line
      break;
    }

    const rowObj: Record<string, unknown> = Object.create(null);

    for (let c = 0; c < expectedColumnCount; c++) {
      const colName = headers[c]!;
      // Keep leading = + - @ unchanged in cells; do not evaluate
      const cellValue = c < rowCells.length ? rowCells[c]! : null;
      rowObj[colName] = cellValue;
    }

    dataRowList.push(rowObj);
  }

  return {
    columns: headers,
    rows: dataRowList,
    totalRowsEncountered: totalDataRows,
    truncated: reachedMaxRows || headerTruncated || droppedPartialLine,
    truncationReason: reachedMaxRows
      ? `Truncated to ${limits.maxRows} rows`
      : undefined,
    dateParseSuccessCount: 0,
    dateRange: null,
  };
}
