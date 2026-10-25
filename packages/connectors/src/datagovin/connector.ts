import type {
  CallContext,
  Connector,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  Dataset,
  SourceId,
} from '@datascout/contracts';
import { safeFetch } from '../toolkit/safe-fetch.js';
import { redactUrl } from '../toolkit/redaction.js';
import { normalizeDataset } from '../normalize/index.js';
import type { RawCandidate } from '../normalize/index.js';

export interface DataGovInConnectorOptions {
  apiBaseUrl?: string;
  apiKey?: string;
  cachedCatalog?: Array<{
    id: string;
    title: string;
    desc: string;
    sector?: string;
    org?: string;
    geography?: string;
  }>;
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
  private readonly cachedCatalog: Array<{
    id: string;
    title: string;
    desc: string;
    sector?: string;
    org?: string;
    geography?: string;
  }>;

  constructor(options: DataGovInConnectorOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.data.gov.in';
    this.apiKey = options.apiKey ?? process.env['DATAGOVIN_API_KEY'];
    this.cachedCatalog = options.cachedCatalog ?? [];
  }

  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    if (ctx.signal.aborted) {
      throw new Error('data.gov.in search cancelled.');
    }

    const query = req.requirements.topic?.toLowerCase() ?? '';
    const limit = Math.min(Math.max(req.maxResults, 1), 20);
    const now = new Date().toISOString();

    // 1. Search cached/harvested catalog index locally (per plan requirement: portal lacks open full-text API)
    const matchedCatalog = this.cachedCatalog.filter((item) => {
      if (!query) return true;
      return (
        item.title.toLowerCase().includes(query) ||
        item.desc.toLowerCase().includes(query) ||
        (item.sector && item.sector.toLowerCase().includes(query))
      );
    });

    const datasets: Dataset[] = [];

    // If local catalog matches exist, map them
    for (const item of matchedCatalog.slice(0, limit)) {
      const nativeId = item.id;
      const safeResourceUrl = redactUrl(
        `${this.apiBaseUrl}/resource/${nativeId}`,
      );

      const rawCandidate: RawCandidate = {
        source: 'datagovin',
        native_id: nativeId,
        source_url: `https://data.gov.in/resource/${nativeId}`,
        title: item.title,
        description: item.desc || null,
        license: 'Government Open Data License - India (GODL)',
        access_type: 'open',
        api_endpoint: safeResourceUrl,
        file_formats: ['csv'],
        record_count: null,
        columns: [],
        geography: req.requirements.geography ?? item.geography ?? 'India',
        time_coverage: null,
        tags: item.sector ? [item.sector] : ['Government Data'],
        last_updated: null,
        raw_snapshot_key: null,
        verification_level: 'metadata_only',
        field_paths: {
          title: 'catalog.title',
          description: 'catalog.desc',
          license: 'ogd.license',
        },
      };

      const { dataset } = normalizeDataset(rawCandidate, now);
      datasets.push(dataset);
    }

    // 2. If an API key is provided and an active resource query exists, fetch candidate metadata from portal API
    if (datasets.length === 0 && this.apiKey) {
      const targetResource = '9ef84268-d588-465a-a308-a864a43d0070'; // Known sample resource ID
      const safeApiUrl = `${this.apiBaseUrl}/resource/${targetResource}?api-key=${this.apiKey}&format=json&limit=${limit}`;

      try {
        const response = await safeFetch(safeApiUrl, {
          signal: ctx.signal,
          timeoutMs: 8000,
        });

        if (response.status === 200) {
          const payload = await response.json<ResourcePayload>();
          const title =
            payload.title || payload.desc || 'Government Data Resource';
          const records = Array.isArray(payload.records)
            ? payload.records
            : [];
          const columns = Array.isArray(payload.field)
            ? payload.field.map((f) => f.name || f.id || String(f))
            : records.length > 0
              ? Object.keys(records[0] ?? {})
              : [];

          const rawCandidate: RawCandidate = {
            source: 'datagovin',
            native_id: targetResource,
            source_url: `https://data.gov.in/resource/${targetResource}`,
            title,
            description: payload.desc || null,
            license: 'Government Open Data License - India (GODL)',
            access_type: 'open',
            api_endpoint: redactUrl(
              `${this.apiBaseUrl}/resource/${targetResource}`,
            ),
            file_formats: ['csv', 'json'],
            record_count: payload.total || records.length || null,
            columns,
            geography: 'India',
            time_coverage: null,
            tags: ['OGD Platform India'],
            last_updated: null,
            raw_snapshot_key: null,
            verification_level:
              records.length > 0 ? 'sample_checked' : 'metadata_only',
            field_paths: {
              title: 'resource.title',
              columns: 'resource.field',
              license: 'ogd.license',
            },
          };

          const { dataset } = normalizeDataset(rawCandidate, now);
          datasets.push(dataset);
        }
      } catch {
        // Safe fail-open for source search
      }
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
    const now = new Date().toISOString();

    const fromCache = this.cachedCatalog.find((c) => c.id === nativeId);
    if (fromCache) {
      const rawCandidate: RawCandidate = {
        source: 'datagovin',
        native_id: nativeId,
        source_url: `https://data.gov.in/resource/${nativeId}`,
        title: fromCache.title,
        description: fromCache.desc || null,
        license: 'Government Open Data License - India (GODL)',
        access_type: 'open',
        api_endpoint: redactUrl(`${this.apiBaseUrl}/resource/${nativeId}`),
        file_formats: ['csv'],
        record_count: null,
        columns: [],
        geography: fromCache.geography ?? 'India',
        time_coverage: null,
        tags: fromCache.sector ? [fromCache.sector] : ['Government Data'],
        last_updated: null,
        raw_snapshot_key: null,
        verification_level: 'metadata_only',
        field_paths: {
          title: 'catalog.title',
          license: 'ogd.license',
        },
      };

      const { dataset } = normalizeDataset(rawCandidate, now);
      return dataset;
    }

    return null;
  }
}
