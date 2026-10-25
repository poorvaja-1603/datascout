import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CallContext,
  Dataset,
  InspectionLimits,
} from '@datascout/contracts';
import {
  BoundedInspector,
  DEFAULT_INSPECTION_LIMITS,
  inspectBytes,
  parseCsv,
  parseJson,
  sanitizeHeaderNames,
  type SampleFetcher,
} from '../src/inspect/index.js';

function createMockDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    dataset_id: 'test/sample-dataset',
    source: 'huggingface',
    native_id: 'test/sample-dataset',
    source_url: 'https://huggingface.co/datasets/test/sample-dataset',
    title: 'Sample Dataset',
    description: 'Sample description for testing inspection.',
    license: 'mit',
    access_type: 'open',
    api_endpoint:
      'https://datasets-server.huggingface.co/rows?dataset=test%2Fsample-dataset',
    file_formats: ['csv'],
    record_count: 100,
    columns: ['id', 'name'],
    geography: null,
    time_coverage: null,
    tags: ['sample'],
    last_updated: '2026-01-01T00:00:00.000Z',
    provenance: {
      source_field_path: 'dataset',
      retrieved_at: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

function createCallContext(
  signal?: AbortSignal,
  deadlineMs?: number,
): CallContext {
  return {
    requestId: 'req-inspect-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    signal: signal ?? new AbortController().signal,
    deadlineMs,
  };
}

describe('Bounded Dataset Inspection', () => {
  const encoder = new TextEncoder();
  const sampleParquetPath = path.resolve(__dirname, 'fixtures/sample.parquet');

  // 1. Normal CSV inspection
  it('inspects a well-formed CSV with types, missingness, duplicates, and evidence', async () => {
    const csvData = [
      'id,name,score,active,created_at',
      '1,Alice,95.5,true,2023-01-01',
      '2,Bob,,false,2023-01-02',
      '3,Charlie,88.0,true,2023-01-03',
      '1,Alice,95.5,true,2023-01-01', // duplicate row
    ].join('\n');

    const dataset = createMockDataset();
    const inspection = await inspectBytes(dataset, encoder.encode(csvData), {
      filename: 'sample.csv',
      contentType: 'text/csv',
    });

    expect(inspection.status).toBe('ok');
    expect(inspection.verificationLevel).toBe('sample_checked');
    expect(inspection.rowsExamined).toBe(4);

    // Column inference
    const colMap = new Map(inspection.columns.map((c) => [c.name, c]));
    expect(colMap.get('id')?.inferredType).toBe('integer');
    expect(colMap.get('id')?.missingRate).toBe(0);
    expect(colMap.get('name')?.inferredType).toBe('string');
    expect(colMap.get('score')?.inferredType).toBe('number');
    expect(colMap.get('score')?.missingRate).toBe(0.25); // 1 missing out of 4
    expect(colMap.get('active')?.inferredType).toBe('boolean');
    expect(colMap.get('created_at')?.inferredType).toBe('date');

    // Duplicate rate: 1 duplicate out of 4 rows = 0.25
    expect(inspection.duplicateRate).toBe(0.25);

    // Date range
    expect(inspection.dateRange).not.toBeNull();
    expect(inspection.dateRange?.start).toContain('2023-01-01');
    expect(inspection.dateRange?.end).toContain('2023-01-03');

    // Evidence checks: strictly matching packages/verify consumed fields
    expect(inspection.evidence).toHaveLength(3);
    const evidenceFields = inspection.evidence.map((e) => e.field);
    expect(evidenceFields).toContain('columns');
    expect(evidenceFields).toContain('record_count');
    expect(evidenceFields).toContain('time_coverage');

    const recordCountEv = inspection.evidence.find(
      (e) => e.field === 'record_count',
    );
    expect(recordCountEv?.value).toBe(4);
    expect(recordCountEv?.provenance.source_field_path).toBe('sample.rows');
  });

  // 2. Normal JSON (array of objects) & JSON Lines (NDJSON)
  it('inspects JSON array of objects correctly', async () => {
    const jsonData = JSON.stringify([
      { id: 1, country: 'India', value: 100 },
      { id: 2, country: 'Germany', value: 200 },
    ]);

    const dataset = createMockDataset({ file_formats: ['json'] });
    const inspection = await inspectBytes(dataset, encoder.encode(jsonData), {
      filename: 'data.json',
    });

    expect(inspection.status).toBe('ok');
    expect(inspection.verificationLevel).toBe('sample_checked');
    expect(inspection.rowsExamined).toBe(2);
    expect(inspection.columns.map((c) => c.name)).toEqual([
      'id',
      'country',
      'value',
    ]);
  });

  it('inspects JSON Lines (NDJSON) correctly', async () => {
    const ndjsonData = [
      JSON.stringify({ user_id: 'u1', count: 10 }),
      JSON.stringify({ user_id: 'u2', count: 20 }),
      JSON.stringify({ user_id: 'u3', count: 30 }),
    ].join('\n');

    const dataset = createMockDataset();
    const inspection = await inspectBytes(dataset, encoder.encode(ndjsonData), {
      filename: 'events.jsonl',
    });

    expect(inspection.status).toBe('ok');
    expect(inspection.verificationLevel).toBe('sample_checked');
    expect(inspection.rowsExamined).toBe(3);
    expect(inspection.columns.map((c) => c.name)).toEqual(['user_id', 'count']);
  });

  // 3. Normal Parquet & BigInt conversion
  it('inspects Parquet fixture, converts BigInt, and is JSON-serializable', async () => {
    const parquetBytes = fs.readFileSync(sampleParquetPath);
    const dataset = createMockDataset({ file_formats: ['parquet'] });

    const inspection = await inspectBytes(dataset, parquetBytes, {
      filename: 'sample.parquet',
    });

    expect(inspection.status).toBe('ok');
    expect(inspection.verificationLevel).toBe('sample_checked');
    expect(inspection.rowsExamined).toBe(3);
    expect(inspection.columns.map((c) => c.name)).toEqual([
      'id',
      'name',
      'score',
      'active',
      'date',
    ]);

    // Ensure serializable to JSON without "Do not know how to serialize a BigInt" error
    const serialized = JSON.stringify(inspection);
    expect(serialized).toContain('"rowsExamined":3');
    expect(serialized).toContain('"verificationLevel":"sample_checked"');
  });

  // 4. Huge CSV truncation
  it('truncates huge CSV to maxRows without throwing', async () => {
    const header = 'idx,value\n';
    const rows: string[] = [];
    for (let i = 0; i < 5000; i++) {
      rows.push(`${i},val_${i}`);
    }
    const hugeCsv = header + rows.join('\n');

    const dataset = createMockDataset();
    const limits: InspectionLimits = {
      ...DEFAULT_INSPECTION_LIMITS,
      maxRows: 1000,
    };

    const inspection = await inspectBytes(dataset, encoder.encode(hugeCsv), {
      limits,
      filename: 'huge.csv',
    });

    expect(inspection.status).toBe('ok');
    expect(inspection.verificationLevel).toBe('sample_checked');
    expect(inspection.rowsExamined).toBe(1000);
  });

  // 5. Security rejections: pickle, .py, .ipynb, zip
  describe('Security Rejections', () => {
    it('blocks binary pickle payload protocol 2/4', async () => {
      // Protocol 2 starts with \x80\x02, Protocol 4 starts with \x80\x04
      const pklBytes = new Uint8Array([
        0x80, 0x04, 0x95, 0x0a, 0x00, 0x00, 0x00,
      ]);
      const dataset = createMockDataset();

      const inspection = await inspectBytes(dataset, pklBytes, {
        filename: 'data.pkl',
      });

      expect(inspection.status).toBe('blocked');
      expect(inspection.verificationLevel).toBe('metadata_only');
      expect(inspection.rowsExamined).toBe(0);
    });

    it('blocks text pickle signatures', async () => {
      const textPickle = 'c__builtin__\nglobals\n(dp0\n';
      const dataset = createMockDataset();

      const inspection = await inspectBytes(
        dataset,
        encoder.encode(textPickle),
        {
          filename: 'data.txt',
        },
      );

      expect(inspection.status).toBe('blocked');
      expect(inspection.verificationLevel).toBe('metadata_only');
      expect(inspection.rowsExamined).toBe(0);
    });

    it('blocks Python scripts by extension and shebang', async () => {
      const pyScript = '#!/usr/bin/env python\nimport os\nprint("hello")\n';
      const dataset = createMockDataset();

      // By filename
      const inspect1 = await inspectBytes(dataset, encoder.encode('x = 1'), {
        filename: 'script.py',
      });
      expect(inspect1.status).toBe('blocked');
      expect(inspect1.verificationLevel).toBe('metadata_only');

      // By content shebang
      const inspect2 = await inspectBytes(dataset, encoder.encode(pyScript), {
        filename: 'script.txt',
      });
      expect(inspect2.status).toBe('blocked');
      expect(inspect2.verificationLevel).toBe('metadata_only');
    });

    it('blocks Jupyter notebook files by extension and JSON structure', async () => {
      const nbJson = JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 2,
      });
      const dataset = createMockDataset();

      // By filename
      const inspect1 = await inspectBytes(dataset, encoder.encode('{}'), {
        filename: 'analysis.ipynb',
      });
      expect(inspect1.status).toBe('blocked');

      // By content sniffing
      const inspect2 = await inspectBytes(dataset, encoder.encode(nbJson), {
        filename: 'data.json',
      });
      expect(inspect2.status).toBe('blocked');
      expect(inspect2.verificationLevel).toBe('metadata_only');
    });

    it('blocks ZIP archive files without decompressing', async () => {
      // Standard ZIP magic bytes: PK\x03\x04
      const zipBytes = new Uint8Array([
        0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
      ]);
      const dataset = createMockDataset();

      const inspect1 = await inspectBytes(dataset, zipBytes);
      expect(inspect1.status).toBe('blocked');
      expect(inspect1.verificationLevel).toBe('metadata_only');

      // Empty ZIP magic bytes: PK\x05\x06
      const emptyZipBytes = new Uint8Array([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00,
      ]);
      const inspect2 = await inspectBytes(dataset, emptyZipBytes);
      expect(inspect2.status).toBe('blocked');

      // By extension
      const inspect3 = await inspectBytes(
        dataset,
        encoder.encode('some-data'),
        {
          filename: 'bundle.zip',
        },
      );
      expect(inspect3.status).toBe('blocked');
    });
  });

  // 6. Mid-parse deadline: result is failed, partial rows do not give sample_checked
  describe('Cooperative Deadline Checking', () => {
    it('returns status failed and metadata_only when deadline expires mid-parse', async () => {
      // Create a CSV with 200 rows so it triggers cooperative check at linesParsed % 20
      const lines = ['id,name'];
      for (let i = 0; i < 200; i++) {
        lines.push(`${i},user_${i}`);
      }
      const csvData = lines.join('\n');
      const dataset = createMockDataset();

      // Deadline set in the past
      const inspection = await inspectBytes(dataset, encoder.encode(csvData), {
        deadlineMs: Date.now() - 1000,
      });

      expect(inspection.status).toBe('failed');
      expect(inspection.verificationLevel).toBe('metadata_only');
      expect(inspection.rowsExamined).toBe(0);
      expect(inspection.columns).toEqual([]);
      expect(inspection.evidence).toEqual([]);
    });

    it('returns status failed and metadata_only when abort signal fires mid-parse', async () => {
      const lines = ['id,name'];
      for (let i = 0; i < 200; i++) {
        lines.push(`${i},user_${i}`);
      }
      const csvData = lines.join('\n');
      const dataset = createMockDataset();

      const controller = new AbortController();
      controller.abort();

      const inspection = await inspectBytes(dataset, encoder.encode(csvData), {
        signal: controller.signal,
      });

      expect(inspection.status).toBe('failed');
      expect(inspection.verificationLevel).toBe('metadata_only');
      expect(inspection.rowsExamined).toBe(0);
    });
  });

  // 7. maxBytes -> too_large enforced before parse
  it('enforces maxBytes before any parse call and returns too_large', async () => {
    const csvData = 'id,val\n1,a\n2,b\n3,c\n';
    const dataset = createMockDataset();
    const limits: InspectionLimits = {
      ...DEFAULT_INSPECTION_LIMITS,
      maxBytes: 10, // very small byte cap
    };

    const inspection = await inspectBytes(dataset, encoder.encode(csvData), {
      limits,
    });

    expect(inspection.status).toBe('too_large');
    expect(inspection.verificationLevel).toBe('metadata_only');
    expect(inspection.rowsExamined).toBe(0);
  });

  // 8. Too many columns
  it('truncates headers past maxColumns and renames empty/duplicate headers', () => {
    const rawHeaders = ['col1', 'col2', 'col1', '', 'col5'];
    const { headers, truncated } = sanitizeHeaderNames(rawHeaders, 4);

    expect(truncated).toBe(true);
    expect(headers).toHaveLength(4);
    expect(headers[0]).toBe('col1');
    expect(headers[1]).toBe('col2');
    expect(headers[2]).toBe('col1_2'); // duplicate renamed
    expect(headers[3]).toBe('column_4'); // empty header renamed
  });

  it('bounds columns when inspecting a CSV exceeding maxColumns', async () => {
    const csvData = 'a,b,c,d,e,f,g\n1,2,3,4,5,6,7\n';
    const dataset = createMockDataset();
    const limits: InspectionLimits = {
      ...DEFAULT_INSPECTION_LIMITS,
      maxColumns: 3,
    };

    const inspection = await inspectBytes(dataset, encoder.encode(csvData), {
      limits,
    });

    expect(inspection.status).toBe('ok');
    expect(inspection.columns).toHaveLength(3);
    expect(inspection.columns.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  // 9. Prototype pollution protection in JSON
  it('skips __proto__, constructor, and prototype keys, and rows use null-prototype objects', async () => {
    const maliciousJson = JSON.stringify([
      {
        __proto__: { polluted: 'yes' },
        constructor: 'exploit',
        prototype: 'exploit',
        normal_key: 'safe_value',
      },
    ]);

    const parsed = parseJson(maliciousJson, DEFAULT_INSPECTION_LIMITS);

    expect(parsed.columns).toEqual(['normal_key']);
    expect(parsed.rows).toHaveLength(1);

    const row = parsed.rows[0]!;
    expect(Object.getPrototypeOf(row)).toBeNull();
    expect(row['normal_key']).toBe('safe_value');
    expect(row['__proto__']).toBeUndefined();
    expect(row['constructor']).toBeUndefined();
    expect(row['prototype']).toBeUndefined();

    // Verify global Object prototype was not polluted
    expect(
      (Object.prototype as unknown as Record<string, unknown>)['polluted'],
    ).toBeUndefined();
  });

  // 10. Binary-as-CSV: NUL bytes and invalid UTF-8
  it('rejects binary files containing NUL bytes as unsupported_format, never CSV', async () => {
    const binaryData = new Uint8Array([
      0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72,
    ]);
    const dataset = createMockDataset();

    const inspection = await inspectBytes(dataset, binaryData, {
      filename: 'test.csv',
    });

    expect(inspection.status).toBe('unsupported_format');
    expect(inspection.verificationLevel).toBe('metadata_only');
    expect(inspection.rowsExamined).toBe(0);
  });

  it('rejects invalid UTF-8 bytes as unsupported_format', async () => {
    // 0xFF, 0xFE, 0xFD are invalid UTF-8 sequences
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x81]);
    const dataset = createMockDataset();

    const inspection = await inspectBytes(dataset, invalidUtf8);

    expect(inspection.status).toBe('unsupported_format');
    expect(inspection.verificationLevel).toBe('metadata_only');
    expect(inspection.rowsExamined).toBe(0);
  });

  // 11. BOM and CRLF CSV
  it('handles UTF-8 BOM and CRLF line endings cleanly in CSV', async () => {
    const bomCrlfCsv = '\uFEFFcol_a,col_b\r\n10,20\r\n30,40\r\n';
    const dataset = createMockDataset();

    const inspection = await inspectBytes(dataset, encoder.encode(bomCrlfCsv));

    expect(inspection.status).toBe('ok');
    expect(inspection.verificationLevel).toBe('sample_checked');
    expect(inspection.rowsExamined).toBe(2);
    expect(inspection.columns[0]?.name).toBe('col_a'); // BOM stripped cleanly
    expect(inspection.columns[1]?.name).toBe('col_b');
  });

  // 12. Truncated JSON array
  it('handles truncated JSON array gracefully returning failed without throwing', async () => {
    const truncatedJson =
      '[{"id": 1, "name": "alice"}, {"id": 2, "name": "bob"';
    const dataset = createMockDataset();

    const inspection = await inspectBytes(
      dataset,
      encoder.encode(truncatedJson),
      {
        filename: 'partial.json',
      },
    );

    expect(inspection.status).toBe('failed');
    expect(inspection.verificationLevel).toBe('metadata_only');
    expect(inspection.rowsExamined).toBe(0);
  });

  // 13. Untrusted CSV cells
  it('keeps leading =+-@ characters untouched and never evaluates formulas', async () => {
    const csvData = [
      'id,formula',
      '1,=1+1',
      '2,@SUM(A1:A10)',
      '3,-100',
      '4,+200',
    ].join('\n');

    const parsed = parseCsv(csvData, DEFAULT_INSPECTION_LIMITS);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows[0]?.['formula']).toBe('=1+1');
    expect(parsed.rows[1]?.['formula']).toBe('@SUM(A1:A10)');
    expect(parsed.rows[2]?.['formula']).toBe('-100');
    expect(parsed.rows[3]?.['formula']).toBe('+200');
  });

  // 14. Injected SampleFetcher interface
  describe('Injected SampleFetcher', () => {
    it('inspect() with no fetcher returns metadata_only and does not fetch', async () => {
      const inspector = new BoundedInspector();
      const dataset = createMockDataset();
      const ctx = createCallContext();

      const result = await inspector.inspect(
        dataset,
        DEFAULT_INSPECTION_LIMITS,
        ctx,
      );

      expect(result.status).toBe('ok');
      expect(result.verificationLevel).toBe('metadata_only');
      expect(result.rowsExamined).toBe(0);
      expect(result.columns).toEqual([]);
      expect(result.evidence).toEqual([]);
    });

    it('inspect() with injected mock fetcher returns sample_checked', async () => {
      const mockCsv = 'id,name\n1,alpha\n2,beta\n';
      const mockFetcher: SampleFetcher = {
        fetchSample: async () => ({
          bytes: encoder.encode(mockCsv),
          filename: 'data.csv',
          contentType: 'text/csv',
        }),
      };

      const inspector = new BoundedInspector(mockFetcher);
      const dataset = createMockDataset();
      const ctx = createCallContext();

      const result = await inspector.inspect(
        dataset,
        DEFAULT_INSPECTION_LIMITS,
        ctx,
      );

      expect(result.status).toBe('ok');
      expect(result.verificationLevel).toBe('sample_checked');
      expect(result.rowsExamined).toBe(2);
      expect(result.columns.map((c) => c.name)).toEqual(['id', 'name']);
    });

    it('inspect() with fetcher returning null returns failed and metadata_only', async () => {
      const mockFetcher: SampleFetcher = {
        fetchSample: async () => null,
      };

      const inspector = new BoundedInspector(mockFetcher);
      const dataset = createMockDataset();
      const ctx = createCallContext();

      const result = await inspector.inspect(
        dataset,
        DEFAULT_INSPECTION_LIMITS,
        ctx,
      );

      expect(result.status).toBe('failed');
      expect(result.verificationLevel).toBe('metadata_only');
      expect(result.rowsExamined).toBe(0);
    });
  });

  // 15. Date formats: unambiguous ISO only
  describe('Date Parsing Rules', () => {
    it('parses unambiguous ISO dates and leaves ambiguous formats as unparsed strings', async () => {
      const csvData = [
        'iso_date,ambiguous_date',
        '2023-01-01,01/02/2020',
        '2023-01-05,03/04/2020',
      ].join('\n');

      const dataset = createMockDataset();
      const inspection = await inspectBytes(dataset, encoder.encode(csvData));

      const colMap = new Map(inspection.columns.map((c) => [c.name, c]));
      expect(colMap.get('iso_date')?.inferredType).toBe('date');
      // Ambiguous DD/MM vs MM/DD stays unparsed as string
      expect(colMap.get('ambiguous_date')?.inferredType).toBe('string');

      // Date range reflects only unambiguous date column
      expect(inspection.dateRange?.start).toContain('2023-01-01');
      expect(inspection.dateRange?.end).toContain('2023-01-05');
    });
  });
});
