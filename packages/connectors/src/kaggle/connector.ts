import type {
  CallContext,
  Connector,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  Dataset,
  InspectionLimits,
  SampleInspection,
  SourceId,
} from '@datascout/contracts';
import { safeFetch } from '../toolkit/safe-fetch.js';
import { redactUrl } from '../toolkit/redaction.js';
import { normalizeDataset } from '../normalize/index.js';
import type { RawCandidate } from '../normalize/index.js';

export interface KaggleConnectorOptions {
  apiBaseUrl?: string;
  apiToken?: string;
}

export interface KaggleDatasetItem {
  id?: number;
  ref?: string;
  title?: string;
  subtitle?: string;
  description?: string;
  url?: string;
  licenseName?: string;
  isPrivate?: boolean;
  lastUpdated?: string;
  totalBytes?: number;
  usabilityRating?: number;
  tags?: Array<{ name?: string; ref?: string; fullPath?: string } | string>;
}

export class KaggleConnector implements Connector {
  readonly source: SourceId = 'kaggle';
  private readonly apiBaseUrl: string;
  private readonly apiToken: string | undefined;

  constructor(options: KaggleConnectorOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://www.kaggle.com/api/v1';
    this.apiToken = options.apiToken ?? process.env['KAGGLE_API_TOKEN'];
  }

  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    if (ctx.signal.aborted) {
      throw new Error('Kaggle search cancelled.');
    }

    const query = req.requirements.topic ?? 'data';
    const limit = Math.min(Math.max(req.maxResults, 1), 20);
    const searchUrl = `${this.apiBaseUrl}/datasets/list?search=${encodeURIComponent(query)}&page=1`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`;
    }

    try {
      const response = await safeFetch(searchUrl, {
        headers,
        signal: ctx.signal,
        timeoutMs: 8000,
      });

      if (response.status !== 200) {
        return {
          source: this.source,
          status: {
            source: this.source,
            status: 'failed',
            result_count: 0,
            warning: `Kaggle API returned HTTP ${response.status}`,
          },
          datasets: [],
        };
      }

      let rawItems = await response.json<KaggleDatasetItem[]>();
      if (Array.isArray(rawItems) && rawItems.length === 0 && query.includes(' ')) {
        const fallbackWord = query.split(/\s+/).find((w) => w.length > 3) ?? query.split(/\s+/)[0];
        if (fallbackWord) {
          const fallbackUrl = `${this.apiBaseUrl}/datasets/list?search=${encodeURIComponent(fallbackWord)}&page=1`;
          const fallbackRes = await safeFetch(fallbackUrl, { headers, signal: ctx.signal, timeoutMs: 8000 }).catch(() => null);
          if (fallbackRes && fallbackRes.status === 200) {
            const items = await fallbackRes.json<KaggleDatasetItem[]>().catch(() => null);
            if (Array.isArray(items) && items.length > 0) rawItems = items;
          }
        }
      }
      if (!Array.isArray(rawItems)) {
        return {
          source: this.source,
          status: {
            source: this.source,
            status: 'failed',
            result_count: 0,
            warning: 'Kaggle API returned non-array payload',
          },
          datasets: [],
        };
      }

      const datasets: Dataset[] = [];
      const now = new Date().toISOString();

      for (const item of rawItems) {
        if (item.isPrivate) {
          continue;
        }

        const nativeId = item.ref || (item.id != null ? String(item.id) : null);
        if (!nativeId || typeof nativeId !== 'string') {
          continue;
        }

        const sourceUrl = item.url || `https://www.kaggle.com/datasets/${nativeId}`;
        const title = item.title || item.ref || nativeId;
        const description = item.subtitle || item.description || null;
        const license = item.licenseName || null;
        const lastUpdated = item.lastUpdated
          ? new Date(item.lastUpdated).toISOString()
          : null;

        const tags: string[] = [];
        if (Array.isArray(item.tags)) {
          for (const t of item.tags) {
            if (typeof t === 'string' && t.trim()) {
              tags.push(t.trim());
            } else if (t && typeof t === 'object') {
              const tagText = t.name || t.ref;
              if (typeof tagText === 'string' && tagText.trim()) {
                tags.push(tagText.trim());
              }
            }
          }
        }

        const rawCandidate: RawCandidate = {
          source: 'kaggle',
          native_id: nativeId,
          source_url: sourceUrl,
          title,
          description,
          license,
          access_type: 'open',
          api_endpoint: redactUrl(`${this.apiBaseUrl}/datasets/view/${nativeId}`),
          file_formats: [],
          record_count: null,
          columns: [],
          geography: null,
          time_coverage: null,
          tags,
          last_updated: lastUpdated,
          raw_snapshot_key: null,
          verification_level: 'metadata_only',
          field_paths: {
            title: 'title',
            description: item.subtitle ? 'subtitle' : 'description',
            license: 'licenseName',
            tags: 'tags',
            last_updated: 'lastUpdated',
          },
        };

        const { dataset } = normalizeDataset(rawCandidate, now);
        datasets.push(dataset);

        if (datasets.length >= limit) {
          break;
        }
      }

      return {
        source: this.source,
        status: {
          source: this.source,
          status: 'success',
          result_count: datasets.length,
          warning: null,
        },
        datasets,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        source: this.source,
        status: {
          source: this.source,
          status: 'failed',
          result_count: 0,
          warning: `Kaggle search failed: ${message}`,
        },
        datasets: [],
      };
    }
  }

  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    if (!datasetId.startsWith('kaggle:')) {
      return null;
    }

    const nativeId = datasetId.slice('kaggle:'.length);
    const detailUrl = `${this.apiBaseUrl}/datasets/view/${nativeId}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`;
    }

    try {
      const response = await safeFetch(detailUrl, {
        headers,
        signal: ctx.signal,
        timeoutMs: 8000,
      });

      if (response.status !== 200) {
        return null;
      }

      const item = await response.json<KaggleDatasetItem>();
      if (!item) return null;

      const now = new Date().toISOString();
      const sourceUrl = item.url || `https://www.kaggle.com/datasets/${nativeId}`;
      const title = item.title || item.ref || nativeId;
      const description = item.description || item.subtitle || null;
      const license = item.licenseName || null;
      const lastUpdated = item.lastUpdated
        ? new Date(item.lastUpdated).toISOString()
        : null;

      const tags: string[] = [];
      if (Array.isArray(item.tags)) {
        for (const t of item.tags) {
          if (typeof t === 'string' && t.trim()) {
            tags.push(t.trim());
          } else if (t && typeof t === 'object') {
            const tagText = t.name || t.ref;
            if (typeof tagText === 'string' && tagText.trim()) {
              tags.push(tagText.trim());
            }
          }
        }
      }

      const rawCandidate: RawCandidate = {
        source: 'kaggle',
        native_id: nativeId,
        source_url: sourceUrl,
        title,
        description,
        license,
        access_type: item.isPrivate ? 'restricted' : 'open',
        api_endpoint: redactUrl(`${this.apiBaseUrl}/datasets/view/${nativeId}`),
        file_formats: [],
        record_count: null,
        columns: [],
        geography: null,
        time_coverage: null,
        tags,
        last_updated: lastUpdated,
        raw_snapshot_key: null,
        verification_level: 'metadata_only',
        field_paths: {
          title: 'title',
          description: 'description',
          license: 'licenseName',
          tags: 'tags',
          last_updated: 'lastUpdated',
        },
      };

      const { dataset } = normalizeDataset(rawCandidate, now);
      return dataset;
    } catch {
      return null;
    }
  }

  async inspectSample(
    dataset: Dataset,
    _limits: InspectionLimits,
    _ctx: CallContext,
  ): Promise<SampleInspection> {
    return {
      datasetId: dataset.dataset_id,
      status: 'ok',
      verificationLevel: 'metadata_only',
      rowsExamined: 0,
      columns: [],
      dateRange: null,
      duplicateRate: null,
      evidence: [],
    };
  }
}
