export type SniffResult =
  | { kind: 'parquet' }
  | { kind: 'json' }
  | { kind: 'jsonl' }
  | { kind: 'csv' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'unsupported'; reason: string };

function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

function isPickle(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  // Python pickle protocols 2..5 start with \x80 followed by protocol number
  if (
    bytes[0] === 0x80 &&
    (bytes[1] === 0x02 ||
      bytes[1] === 0x03 ||
      bytes[1] === 0x04 ||
      bytes[1] === 0x05)
  ) {
    return true;
  }

  // Protocol 0/1 text signatures: c__builtin__, cos\nsystem, (dp
  const prefix = new TextDecoder('latin1').decode(bytes.slice(0, 100));
  if (
    prefix.startsWith('c__builtin__') ||
    prefix.startsWith('cos\nsystem') ||
    prefix.startsWith('(dp') ||
    prefix.startsWith('(lp')
  ) {
    return true;
  }

  return false;
}

function isParquet(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // Magic bytes "PAR1" at the start
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x41 &&
    bytes[2] === 0x52 &&
    bytes[3] === 0x31
  );
}

function containsNulByte(bytes: Uint8Array, scanLimit = 8192): boolean {
  const limit = Math.min(bytes.length, scanLimit);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x00) {
      return true;
    }
  }
  return false;
}

export function sniffFormat(
  bytes: Uint8Array,
  filename?: string,
  contentType?: string,
): SniffResult {
  if (bytes.length === 0) {
    return { kind: 'unsupported', reason: 'Empty payload (0 bytes)' };
  }

  const lowerName = filename?.toLowerCase() ?? '';
  const lowerCt = contentType?.toLowerCase() ?? '';

  // 1. Explicit extension/metadata blocks
  if (lowerName.endsWith('.py') || lowerCt.includes('x-python')) {
    return { kind: 'blocked', reason: 'Python executable scripts are blocked' };
  }
  if (lowerName.endsWith('.ipynb')) {
    return { kind: 'blocked', reason: 'Jupyter notebook files are blocked' };
  }
  if (
    lowerName.endsWith('.pkl') ||
    lowerName.endsWith('.pickle') ||
    lowerCt.includes('pickle')
  ) {
    return { kind: 'blocked', reason: 'Pickle files are blocked' };
  }
  if (
    lowerName.endsWith('.zip') ||
    lowerName.endsWith('.tar') ||
    lowerName.endsWith('.gz') ||
    lowerName.endsWith('.7z') ||
    lowerCt.includes('zip') ||
    lowerCt.includes('tar') ||
    lowerCt.includes('gzip')
  ) {
    return {
      kind: 'blocked',
      reason: 'Archive files (ZIP) are blocked from in-memory inspection',
    };
  }

  // 2. Binary signatures
  if (isZip(bytes)) {
    return {
      kind: 'blocked',
      reason: 'Archive files (ZIP) are blocked from in-memory inspection',
    };
  }

  if (isPickle(bytes)) {
    return { kind: 'blocked', reason: 'Pickle payload detected and blocked' };
  }

  if (isParquet(bytes)) {
    return { kind: 'parquet' };
  }

  // 3. Binary detection: NUL bytes in non-Parquet files must not become CSV
  if (containsNulByte(bytes)) {
    return {
      kind: 'unsupported',
      reason: 'Binary content with NUL bytes is not a supported tabular format',
    };
  }

  // 4. Validate UTF-8 encoding
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      kind: 'unsupported',
      reason: 'Invalid UTF-8 text encoding',
    };
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: 'unsupported', reason: 'Whitespace-only content' };
  }

  // Check for notebook contents inside JSON text
  if (
    trimmed.startsWith('{') &&
    trimmed.includes('"cells"') &&
    trimmed.includes('"nbformat"')
  ) {
    return { kind: 'blocked', reason: 'Jupyter notebook detected and blocked' };
  }

  // Check for Python script shebang / code in text
  if (
    trimmed.startsWith('#!/usr/bin/env python') ||
    trimmed.startsWith('#!/usr/bin/python')
  ) {
    return {
      kind: 'blocked',
      reason: 'Python executable script detected and blocked',
    };
  }

  // 5. JSON formats
  if (trimmed.startsWith('[')) {
    return { kind: 'json' };
  }

  if (trimmed.startsWith('{')) {
    // Distinguish single JSON object vs JSON Lines (NDJSON)
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline !== -1) {
      const firstLine = trimmed.slice(0, firstNewline).trim();
      const secondLine = trimmed.slice(firstNewline + 1).trim();
      if (firstLine.endsWith('}') && secondLine.startsWith('{')) {
        return { kind: 'jsonl' };
      }
    }
    // Single JSON object can be treated as a 1-row table
    return { kind: 'json' };
  }

  // 6. CSV / TSV text
  return { kind: 'csv' };
}
