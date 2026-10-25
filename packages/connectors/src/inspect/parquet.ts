import { parquetMetadata, parquetRead } from 'hyparquet';
import { DeadlineExceededError, sanitizeHeaderNames } from './csv.js';
import type { InspectionLimits, ParsedTable } from './types.js';

function safeConvertBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') {
    if (
      value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      return Number(value);
    }
    return value.toString();
  }
  return value;
}

export async function parseParquet(
  bytes: Uint8Array,
  limits: InspectionLimits,
  deadlineMs?: number,
  signal?: AbortSignal,
): Promise<ParsedTable> {
  if (
    signal?.aborted ||
    (deadlineMs !== undefined && Date.now() > deadlineMs)
  ) {
    throw new DeadlineExceededError();
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const arrayBuffer: ArrayBuffer = copy.buffer;

  let metadata: ReturnType<typeof parquetMetadata>;
  try {
    metadata = parquetMetadata(arrayBuffer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unsupported or malformed Parquet file: ${message}`, {
      cause: err,
    });
  }

  // 1. Validate column count and extract names from metadata before decoding
  const schemaElements = metadata.schema ?? [];
  // schema[0] is typically the root record schema; remaining are fields
  const columnElements =
    schemaElements.length > 1 ? schemaElements.slice(1) : [];
  const rawColumnNames = columnElements.map(
    (elem, idx) => elem.name ?? `column_${idx + 1}`,
  );

  const { headers, truncated: headerTruncated } = sanitizeHeaderNames(
    rawColumnNames,
    limits.maxColumns,
  );

  const totalNumRows = Number(metadata.num_rows ?? 0);
  const rowsToRead = Math.min(totalNumRows, limits.maxRows);
  const rowsTruncated = totalNumRows > limits.maxRows;

  // 2. Decode columns and rows with limits using parquetRead
  const rows: Array<Record<string, unknown>> = [];

  try {
    await parquetRead({
      file: arrayBuffer,
      columns: headers,
      rowStart: 0,
      rowEnd: rowsToRead,
      onComplete: (data: unknown[][]) => {
        // data is an array of rows: data[rowIndex][colIndex]
        const rowCount = data.length;

        for (let r = 0; r < rowCount; r++) {
          if (r % 50 === 0) {
            if (
              signal?.aborted ||
              (deadlineMs !== undefined && Date.now() > deadlineMs)
            ) {
              throw new DeadlineExceededError();
            }
          }

          const rowCells = data[r] ?? [];
          const rowObj: Record<string, unknown> = Object.create(null);
          for (let c = 0; c < headers.length; c++) {
            const colName = headers[c]!;
            const cell = c < rowCells.length ? rowCells[c] : null;
            rowObj[colName] = safeConvertBigInt(cell);
          }
          rows.push(rowObj);
        }
      },
    });
  } catch (err: unknown) {
    if (err instanceof DeadlineExceededError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unsupported Parquet codec or data: ${message}`, {
      cause: err,
    });
  }

  return {
    columns: headers,
    rows,
    totalRowsEncountered: totalNumRows,
    truncated: rowsTruncated || headerTruncated,
    truncationReason: rowsTruncated
      ? `Truncated to ${limits.maxRows} rows`
      : undefined,
    dateParseSuccessCount: 0,
    dateRange: null,
  };
}
