import type {
  CallContext,
  Connector,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  Dataset,
  InspectionLimits,
  Inspector,
  SampleInspection,
  SourceId,
} from '@datascout/contracts';
import { safeFetch } from '../toolkit/safe-fetch.js';
import { redactErrorMessage, redactUrl } from '../toolkit/redaction.js';
import { abortableSleep } from '../toolkit/retry.js';
import { normalizeDataset } from '../normalize/index.js';
import type { RawCandidate } from '../normalize/index.js';
import { BoundedInspector, inspectBytes } from '../inspect/inspector.js';
import { sniffFormat } from '../inspect/detector.js';
import { parseCsv } from '../inspect/csv.js';

export const DATAGOVIN_NATIVE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function isValidNativeId(id: string): boolean {
  return typeof id === 'string' && DATAGOVIN_NATIVE_ID_PATTERN.test(id);
}

export interface CachedCatalogEntry {
  id: string;
  title: string;
  desc: string;
  sector?: string | undefined;
  org?: string | undefined;
  geography?: string | undefined;
}

export interface DataGovInConnectorOptions {
  apiBaseUrl?: string | undefined;
  apiKey?: string | undefined;
  cachedCatalog?: CachedCatalogEntry[] | undefined;
  inspector?: Inspector | undefined;
}

export interface HarvestCatalogOptions {
  signal?: AbortSignal | undefined;
  maxRecords?: number | undefined;
  pageSize?: number | undefined;
  maxPages?: number | undefined;
  maxBytes?: number | undefined;
  pageDelayMs?: number | undefined;
}

export interface HarvestCatalogResult {
  datasets: Dataset[];
  rawEntries: CachedCatalogEntry[];
  counts: {
    fetched: number;
    skipped: number;
    failed: number;
  };
  totalBytes: number;
  pagesFetched: number;
  warnings: string[];
}

export interface FetchResourceSampleOptions {
  nativeId: string;
  offset?: number | undefined;
  limit?: number | undefined;
  filters?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface ResourceSampleResult {
  nativeId: string;
  format: 'json' | 'csv';
  records: Array<Record<string, unknown>>;
  columns: string[];
  total: number | null;
  rawBytes: Uint8Array;
  title?: string | undefined;
  description?: string | undefined;
}

interface ResourcePayload {
  title?: string;
  desc?: string;
  records?: Record<string, unknown>[];
  field?: Array<{ name?: string; id?: string }>;
  total?: number;
}

export class DataGovInConnector implements Connector {
  readonly source: SourceId = 'datagovin';
  private readonly apiBaseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly cachedCatalog: CachedCatalogEntry[];
  private readonly inspector: Inspector;

  constructor(options: DataGovInConnectorOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.data.gov.in';
    this.apiKey = options.apiKey ?? process.env['DATAGOVIN_API_KEY'];
    this.cachedCatalog = options.cachedCatalog
      ? [...options.cachedCatalog]
      : [];
    this.inspector = options.inspector ?? new BoundedInspector();
  }

  /**
   * Populate or append entries into the in-memory cached catalog.
   */
  populateCatalog(entries: CachedCatalogEntry[]): void {
    this.cachedCatalog.push(...entries);
  }

  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    if (ctx.signal.aborted) {
      throw new Error('data.gov.in search cancelled.');
    }

    // Candidate search uses the public harvested catalog and does not require the
    // API key; credentials are needed only for protected resource details/samples.
    // If cached catalog is empty, return a partial source status.
    if (this.cachedCatalog.length === 0) {
      return {
        source: this.source,
        status: {
          source: this.source,
          status: 'partial',
          result_count: 0,
          warning:
            'data.gov.in catalog index is empty; run catalog harvest first',
        },
        datasets: [],
      };
    }

    const query = req.requirements.topic?.toLowerCase() ?? '';
    const limit = Math.min(Math.max(req.maxResults, 1), 20);
    const now = new Date().toISOString();

    // 3. Search cached/harvested catalog index locally
    const matchedCatalog = this.cachedCatalog.filter((item) => {
      if (!isValidNativeId(item.id)) return false;
      if (!query) return true;
      return (
        item.title.toLowerCase().includes(query) ||
        item.desc.toLowerCase().includes(query) ||
        (item.sector && item.sector.toLowerCase().includes(query))
      );
    });

    const datasets: Dataset[] = [];

    for (const item of matchedCatalog.slice(0, limit)) {
      const nativeId = item.id;
      const safeResourceUrl = redactUrl(
        `${this.apiBaseUrl}/resource/${nativeId}`,
      );

      // Provenance only for fields actually present/read
      const fieldPaths: Record<string, string> = {
        title: 'catalog.title',
      };
      if (item.desc) fieldPaths['description'] = 'catalog.desc';
      if (item.sector) fieldPaths['tags'] = 'catalog.sector';
      if (item.geography) fieldPaths['geography'] = 'catalog.geography';

      const rawCandidate: RawCandidate = {
        source: 'datagovin',
        native_id: nativeId,
        source_url: `https://data.gov.in/resource/${nativeId}`,
        title: item.title,
        description: item.desc || null,
        license: null, // Unknown/unspecified; never invent GODL
        access_type: null, // Unknown/unspecified; never assume 'open'
        api_endpoint: safeResourceUrl,
        file_formats: [], // Unknown/unspecified; never assume ['csv']
        record_count: null, // Only from verified integer total
        columns: [],
        geography: item.geography || null, // Never invent from request
        time_coverage: null,
        tags: item.sector ? [item.sector] : [],
        last_updated: null,
        raw_snapshot_key: null,
        verification_level: 'metadata_only',
        field_paths: fieldPaths,
      };

      const { dataset } = normalizeDataset(rawCandidate, now);
      datasets.push(dataset);
    }

    return {
      source: this.source,
      status: {
        source: this.source,
        status: 'success',
        result_count: datasets.length,
        warning:
          datasets.length === 0
            ? 'No matching data.gov.in datasets found'
            : null,
      },
      datasets,
    };
  }

  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    if (ctx.signal.aborted) {
      throw new Error('data.gov.in getDetails cancelled.');
    }
    if (!datasetId.startsWith('datagovin:')) {
      return null;
    }

    const nativeId = datasetId.slice('datagovin:'.length);
    if (!isValidNativeId(nativeId)) {
      return null;
    }

    const now = new Date().toISOString();

    // 1. Check local catalog cache first
    const fromCache = this.cachedCatalog.find((c) => c.id === nativeId);
    if (fromCache) {
      const fieldPaths: Record<string, string> = {
        title: 'catalog.title',
      };
      if (fromCache.desc) fieldPaths['description'] = 'catalog.desc';
      if (fromCache.sector) fieldPaths['tags'] = 'catalog.sector';
      if (fromCache.geography) fieldPaths['geography'] = 'catalog.geography';

      const rawCandidate: RawCandidate = {
        source: 'datagovin',
        native_id: nativeId,
        source_url: `https://data.gov.in/resource/${nativeId}`,
        title: fromCache.title,
        description: fromCache.desc || null,
        license: null,
        access_type: null,
        api_endpoint: redactUrl(`${this.apiBaseUrl}/resource/${nativeId}`),
        file_formats: [],
        record_count: null,
        columns: [],
        geography: fromCache.geography || null,
        time_coverage: null,
        tags: fromCache.sector ? [fromCache.sector] : [],
        last_updated: null,
        raw_snapshot_key: null,
        verification_level: 'metadata_only',
        field_paths: fieldPaths,
      };

      const { dataset } = normalizeDataset(rawCandidate, now);
      return dataset;
    }

    // 2. Live API fallback when not in cache and API key is present
    if (this.apiKey) {
      try {
        const safeApiUrl = `${this.apiBaseUrl}/resource/${nativeId}?api-key=${encodeURIComponent(this.apiKey)}&format=json&limit=1`;
        const response = await safeFetch(safeApiUrl, {
          signal: ctx.signal,
          timeoutMs: 8000,
        });

        if (response.status === 200) {
          const payload = await response.json<ResourcePayload>();
          const title = payload.title || payload.desc;
          if (!title) return null;

          const records = Array.isArray(payload.records) ? payload.records : [];
          const columns = Array.isArray(payload.field)
            ? payload.field.map((f) => f.name || f.id || String(f))
            : records.length > 0
              ? Object.keys(records[0] ?? {})
              : [];

          const recordCount =
            typeof payload.total === 'number' &&
            Number.isInteger(payload.total) &&
            payload.total >= 0
              ? payload.total
              : null;

          const fieldPaths: Record<string, string> = {};
          if (payload.title) fieldPaths['title'] = 'resource.title';
          else if (payload.desc) fieldPaths['title'] = 'resource.desc';
          if (payload.desc) fieldPaths['description'] = 'resource.desc';
          if (columns.length > 0) fieldPaths['columns'] = 'resource.field';
          if (recordCount !== null)
            fieldPaths['record_count'] = 'resource.total';

          const rawCandidate: RawCandidate = {
            source: 'datagovin',
            native_id: nativeId,
            source_url: `https://data.gov.in/resource/${nativeId}`,
            title,
            description: payload.desc || null,
            license: null,
            access_type: null,
            api_endpoint: redactUrl(`${this.apiBaseUrl}/resource/${nativeId}`),
            file_formats: [],
            record_count: recordCount,
            columns,
            geography: null,
            time_coverage: null,
            tags: [],
            last_updated: null,
            raw_snapshot_key: null,
            verification_level: 'metadata_only',
            field_paths: fieldPaths,
          };

          const { dataset } = normalizeDataset(rawCandidate, now);
          return dataset;
        }
      } catch {
        // Safe fail-open for live fallback
        return null;
      }
    }

    return null;
  }

  /**
   * Harvests catalog metadata from the data.gov.in /catalogs endpoint with
   * hard limits on total records, page size, maximum pages, and total bytes.
   */
  async harvestCatalog(
    options: HarvestCatalogOptions = {},
  ): Promise<HarvestCatalogResult> {
    const maxRecords = options.maxRecords ?? 1000;
    const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 1000);
    const maxPages = options.maxPages ?? 50;
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024; // 10MB default
    const pageDelayMs = options.pageDelayMs ?? 100;
    const signal = options.signal;

    const datasets: Dataset[] = [];
    const rawEntries: CachedCatalogEntry[] = [];
    const seenIds = new Set<string>();
    const counts = { fetched: 0, skipped: 0, failed: 0 };
    const warnings: string[] = [];

    let offset = 0;
    let pagesFetched = 0;
    let totalBytes = 0;
    const now = new Date().toISOString();

    while (datasets.length < maxRecords) {
      if (signal?.aborted) {
        warnings.push('Catalog harvest aborted by caller.');
        break;
      }

      if (pagesFetched >= maxPages) {
        warnings.push(
          `Reached maximum page limit of ${maxPages} during catalog harvest.`,
        );
        break;
      }

      if (totalBytes >= maxBytes) {
        warnings.push(
          `Reached maximum byte limit of ${maxBytes} during catalog harvest.`,
        );
        break;
      }

      // Polite rate-limiting between pages
      if (pagesFetched > 0 && pageDelayMs > 0) {
        await abortableSleep(pageDelayMs, signal);
      }

      const limit = Math.min(pageSize, maxRecords - datasets.length);
      const url = new URL(`${this.apiBaseUrl}/catalogs`);
      url.searchParams.set('format', 'json');
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('limit', String(limit));
      if (this.apiKey) {
        url.searchParams.set('api-key', this.apiKey);
      }

      try {
        const remainingBytes = Math.max(maxBytes - totalBytes, 1024);
        const response = await safeFetch(url.toString(), {
          signal: signal ?? null,
          timeoutMs: 10000,
          maxBytes: remainingBytes,
          allowedContentTypes: ['application/json', 'text/plain'],
        });

        const pageBytes = await response.bytes();
        totalBytes += pageBytes.byteLength;
        pagesFetched++;

        const text = new TextDecoder('utf-8').decode(pageBytes);
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch (parseErr: unknown) {
          counts.failed++;
          const safeMsg = redactErrorMessage(
            parseErr instanceof Error ? parseErr.message : String(parseErr),
          );
          warnings.push(`Malformed JSON at offset ${offset}: ${safeMsg}`);
          break;
        }

        const items: unknown[] = Array.isArray(payload)
          ? payload
          : Array.isArray((payload as Record<string, unknown>)?.['records'])
            ? ((payload as Record<string, unknown>)['records'] as unknown[])
            : Array.isArray((payload as Record<string, unknown>)?.['catalogs'])
              ? ((payload as Record<string, unknown>)['catalogs'] as unknown[])
              : [];

        if (items.length === 0) {
          break; // No more records
        }

        for (const item of items) {
          if (datasets.length >= maxRecords) break;

          if (!item || typeof item !== 'object') {
            counts.skipped++;
            continue;
          }

          const raw = item as Record<string, unknown>;
          const rawId =
            raw['id'] ??
            raw['index_name'] ??
            raw['catalog_uuid'] ??
            raw['resource_id'];
          const id = typeof rawId === 'string' ? rawId.trim() : '';
          const title =
            typeof raw['title'] === 'string' ? raw['title'].trim() : '';
          const desc =
            typeof raw['desc'] === 'string'
              ? raw['desc'].trim()
              : typeof raw['description'] === 'string'
                ? raw['description'].trim()
                : '';

          // Validate native ID: strict pattern
          if (!isValidNativeId(id) || !title || seenIds.has(id)) {
            counts.skipped++;
            continue;
          }
          seenIds.add(id);

          const sector =
            typeof raw['sector'] === 'string' && raw['sector'].trim()
              ? raw['sector'].trim()
              : undefined;
          const org =
            typeof raw['org'] === 'string' && raw['org'].trim()
              ? raw['org'].trim()
              : undefined;
          const geography =
            typeof raw['geography'] === 'string' && raw['geography'].trim()
              ? raw['geography'].trim()
              : undefined;

          const entry: CachedCatalogEntry = {
            id,
            title,
            desc,
            sector,
            org,
            geography,
          };
          rawEntries.push(entry);

          const fieldPaths: Record<string, string> = {
            title: 'catalog.title',
          };
          if (desc) fieldPaths['description'] = 'catalog.desc';
          if (sector) fieldPaths['tags'] = 'catalog.sector';
          if (geography) fieldPaths['geography'] = 'catalog.geography';

          const rawCandidate: RawCandidate = {
            source: 'datagovin',
            native_id: id,
            source_url: `https://data.gov.in/resource/${id}`,
            title,
            description: desc || null,
            license: null,
            access_type: null,
            api_endpoint: redactUrl(`${this.apiBaseUrl}/resource/${id}`),
            file_formats: [],
            record_count: null,
            columns: [],
            geography: geography || null,
            time_coverage: null,
            tags: sector ? [sector] : [],
            last_updated: null,
            raw_snapshot_key: null,
            verification_level: 'metadata_only',
            field_paths: fieldPaths,
          };

          const { dataset } = normalizeDataset(rawCandidate, now);
          datasets.push(dataset);
          counts.fetched++;
        }

        offset += items.length;
        if (items.length < limit) {
          break; // Last page
        }
      } catch (fetchErr: unknown) {
        counts.failed++;
        const safeMsg = redactErrorMessage(
          fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        );
        warnings.push(`Catalog harvest failed at offset ${offset}: ${safeMsg}`);
        break;
      }
    }

    return {
      datasets,
      rawEntries,
      counts,
      totalBytes,
      pagesFetched,
      warnings,
    };
  }

  /**
   * Fetches a bounded sample from data.gov.in's resource endpoint.
   * Handles CSV response even when JSON was requested, and keeps filter
   * field names case-sensitive. All errors are guaranteed to be redacted.
   */
  async fetchResourceSample(
    options: FetchResourceSampleOptions,
  ): Promise<ResourceSampleResult> {
    const {
      nativeId,
      offset = 0,
      limit = 100,
      filters,
      signal,
      timeoutMs = 8000,
    } = options;

    if (!isValidNativeId(nativeId)) {
      throw new Error(`Invalid data.gov.in native resource ID: ${nativeId}`);
    }

    if (!this.apiKey) {
      throw new Error(
        'data.gov.in API key is required to fetch resource samples',
      );
    }

    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const url = new URL(`${this.apiBaseUrl}/resource/${nativeId}`);
    url.searchParams.set('api-key', this.apiKey);
    url.searchParams.set('format', 'json');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(boundedLimit));

    // Case-sensitive filter field names: do not alter casing
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        url.searchParams.set(`filters[${key}]`, value);
      }
    }

    let rawBytes: Uint8Array;
    let contentTypeHeader: string | undefined;
    try {
      const response = await safeFetch(url.toString(), {
        signal: signal ?? null,
        timeoutMs,
        maxBytes: 10 * 1024 * 1024,
        allowedContentTypes: ['application/json', 'text/csv', 'text/plain'],
      });

      contentTypeHeader = response.headers.get('content-type') ?? undefined;
      rawBytes = await response.bytes();
    } catch (err: unknown) {
      const safeMsg = redactErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
      throw new Error(`Failed to fetch resource sample: ${safeMsg}`, {
        cause: err,
      });
    }

    // Sniff content format (handles portal quirk of returning CSV on format=json)
    const text = new TextDecoder('utf-8').decode(rawBytes);
    const trimmed = text.trim();
    const isLikelyJson = trimmed.startsWith('{') || trimmed.startsWith('[');

    if (isLikelyJson) {
      try {
        const payload = JSON.parse(trimmed) as ResourcePayload;
        const records = Array.isArray(payload.records)
          ? payload.records
          : Array.isArray(payload)
            ? (payload as Record<string, unknown>[])
            : [];

        const columns = Array.isArray(payload.field)
          ? payload.field.map((f) => f.name || f.id || String(f))
          : records.length > 0
            ? Object.keys(records[0] ?? {})
            : [];

        const total =
          typeof payload.total === 'number' &&
          Number.isInteger(payload.total) &&
          payload.total >= 0
            ? payload.total
            : null;

        return {
          nativeId,
          format: 'json',
          records,
          columns,
          total,
          rawBytes,
          title: payload.title,
          description: payload.desc,
        };
      } catch {
        // Fall through to CSV parsing if JSON parse fails
      }
    }

    // Parse as CSV (either explicit CSV or fallback for CSV-on-JSON quirk)
    try {
      const sniff = sniffFormat(rawBytes, `${nativeId}.csv`, contentTypeHeader);
      if (sniff.kind === 'blocked') {
        throw new Error('Resource sample payload is blocked by security guard');
      }

      const csvLimits: InspectionLimits = {
        maxRows: boundedLimit,
        maxBytes: 10 * 1024 * 1024,
        maxColumns: 200,
        timeoutMs,
      };
      const parsed = parseCsv(text, csvLimits, undefined, signal);
      return {
        nativeId,
        format: 'csv',
        records: parsed.rows,
        columns: parsed.columns,
        total: null,
        rawBytes,
      };
    } catch (parseErr: unknown) {
      const safeMsg = redactErrorMessage(
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
      throw new Error(`Failed to parse resource sample CSV: ${safeMsg}`, {
        cause: parseErr,
      });
    }
  }

  /**
   * Performs bounded inspection on a dataset sample using the inspect module.
   */
  async inspectSample(
    dataset: Dataset,
    limits: InspectionLimits,
    ctx: CallContext,
  ): Promise<SampleInspection> {
    const emptyResult = (
      status: SampleInspection['status'],
      verificationLevel: SampleInspection['verificationLevel'] = 'metadata_only',
    ): SampleInspection => ({
      datasetId: dataset.dataset_id,
      status,
      verificationLevel,
      rowsExamined: 0,
      columns: [],
      dateRange: null,
      duplicateRate: null,
      evidence: [],
    });

    if (ctx.signal.aborted) {
      return emptyResult('failed');
    }

    const nativeId = dataset.dataset_id.startsWith('datagovin:')
      ? dataset.dataset_id.slice('datagovin:'.length)
      : dataset.dataset_id;

    if (!isValidNativeId(nativeId)) {
      return emptyResult('failed');
    }

    if (!this.apiKey) {
      return emptyResult('blocked');
    }

    let sampleResult: ResourceSampleResult;
    try {
      sampleResult = await this.fetchResourceSample({
        nativeId,
        limit: limits.maxRows,
        signal: ctx.signal,
        timeoutMs: limits.timeoutMs,
      });
    } catch {
      return emptyResult('failed');
    }

    // Inspect the fetched sample using BoundedInspector
    try {
      if (sampleResult.format === 'csv') {
        return await inspectBytes(dataset, sampleResult.rawBytes, {
          limits,
          signal: ctx.signal,
          deadlineMs: ctx.deadlineMs,
          contentType: 'text/csv',
          filename: `${nativeId}.csv`,
        });
      } else {
        const recordsJson = JSON.stringify(sampleResult.records);
        const recordsBytes = new TextEncoder().encode(recordsJson);
        return await inspectBytes(dataset, recordsBytes, {
          limits,
          signal: ctx.signal,
          deadlineMs: ctx.deadlineMs,
          contentType: 'application/json',
          filename: `${nativeId}.json`,
        });
      }
    } catch {
      return emptyResult('failed');
    }
  }
}
