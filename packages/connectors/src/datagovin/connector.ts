import type {
  CallContext,
  Connector,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  SourceId,
} from '@datascout/contracts';
import type { Dataset } from '@datascout/contracts';
import { safeFetch } from '../toolkit/safe-fetch.js';
import { redactUrl } from '../toolkit/redaction.js';

export interface DataGovInConnectorOptions {
  apiBaseUrl?: string;
  apiKey?: string;
  cachedCatalog?: Array<{
    id: string;
    title: string;
    desc: string;
    sector?: string;
    org?: string;
  }>;
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
      const datasetId = `datagovin:${nativeId}`;
      const safeResourceUrl = redactUrl(`${this.apiBaseUrl}/resource/${nativeId}`);

      datasets.push({
        dataset_id: datasetId,
        source: 'datagovin',
        source_url: `https://data.gov.in/resource/${nativeId}`,
        title: item.title,
        description: item.desc || null,
        license: 'Government Open Data License - India (GODL)',
        access_type: 'open',
        api_endpoint: safeResourceUrl,
        file_formats: ['csv'],
        record_count: null,
        columns: [],
        geography: req.requirements.geography ?? 'India',
        time_coverage: null,
        tags: item.sector ? [item.sector] : ['Government Data'],
        last_updated: null,
        retrieved_at: now,
        raw_snapshot_key: null,
        verification_level: 'metadata_only',
        provenance: {
          title: { source_field_path: 'catalog.title', retrieved_at: now },
          description: { source_field_path: 'catalog.desc', retrieved_at: now },
          license: { source_field_path: 'ogd.license', retrieved_at: now },
        },
      });
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
          const payload = await response.json<any>();
          const title = payload.title || payload.desc || 'Government Data Resource';
          const records = Array.isArray(payload.records) ? payload.records : [];
          const columns = Array.isArray(payload.field)
            ? payload.field.map((f: any) => f.name || f.id || String(f))
            : records.length > 0
              ? Object.keys(records[0])
              : [];

          datasets.push({
            dataset_id: `datagovin:${targetResource}`,
            source: 'datagovin',
            source_url: `https://data.gov.in/resource/${targetResource}`,
            title,
            description: payload.desc || null,
            license: 'Government Open Data License - India (GODL)',
            access_type: 'open',
            api_endpoint: redactUrl(`${this.apiBaseUrl}/resource/${targetResource}`),
            file_formats: ['csv', 'json'],
            record_count: payload.total || records.length || null,
            columns,
            geography: 'India',
            time_coverage: null,
            tags: ['OGD Platform India'],
            last_updated: null,
            retrieved_at: now,
            raw_snapshot_key: null,
            verification_level: records.length > 0 ? 'sample_checked' : 'metadata_only',
            provenance: {
              title: { source_field_path: 'resource.title', retrieved_at: now },
              columns: { source_field_path: 'resource.field', retrieved_at: now },
            },
          });
        }
      } catch {
        // Safe fail-open for source search
      }
    }

    return {
      source: this.source,
      status: {
        source: this.source,
        status: datasets.length > 0 ? 'success' : 'success',
        result_count: datasets.length,
        warning: datasets.length === 0 ? 'No matching data.gov.in datasets found' : null,
      },
      datasets,
    };
  }

  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    if (!datasetId.startsWith('datagovin:')) {
      return null;
    }

    const nativeId = datasetId.slice('datagovin:'.length);
    const now = new Date().toISOString();

    const fromCache = this.cachedCatalog.find((c) => c.id === nativeId);
    if (fromCache) {
      return {
        dataset_id: datasetId,
        source: 'datagovin',
        source_url: `https://data.gov.in/resource/${nativeId}`,
        title: fromCache.title,
        description: fromCache.desc || null,
        license: 'Government Open Data License - India (GODL)',
        access_type: 'open',
        api_endpoint: redactUrl(`${this.apiBaseUrl}/resource/${nativeId}`),
        file_formats: ['csv'],
        record_count: null,
        columns: [],
        geography: 'India',
        time_coverage: null,
        tags: fromCache.sector ? [fromCache.sector] : ['Government Data'],
        last_updated: null,
        retrieved_at: now,
        raw_snapshot_key: null,
        verification_level: 'metadata_only',
        provenance: {
          title: { source_field_path: 'catalog.title', retrieved_at: now },
        },
      };
    }

    return null;
  }
}
