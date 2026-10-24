import type {
  CallContext,
  Connector,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  SourceId,
} from '@datascout/contracts';
import type { Dataset, SourceStatus } from '@datascout/contracts';
import { safeFetch } from '../toolkit/safe-fetch.js';
import { redactUrl } from '../toolkit/redaction.js';

export interface HuggingFaceConnectorOptions {
  hubApiBaseUrl?: string;
  viewerApiBaseUrl?: string;
  apiToken?: string;
}

export class HuggingFaceConnector implements Connector {
  readonly source: SourceId = 'huggingface';
  private readonly hubApiBaseUrl: string;
  private readonly viewerApiBaseUrl: string;
  private readonly apiToken: string | undefined;

  constructor(options: HuggingFaceConnectorOptions = {}) {
    this.hubApiBaseUrl = options.hubApiBaseUrl ?? 'https://huggingface.co/api';
    this.viewerApiBaseUrl =
      options.viewerApiBaseUrl ?? 'https://datasets-server.huggingface.co';
    this.apiToken = options.apiToken;
  }

  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    if (ctx.signal.aborted) {
      throw new Error('Hugging Face search cancelled.');
    }

    const query = req.requirements.topic ?? 'machine learning';
    const limit = Math.min(Math.max(req.maxResults, 1), 20);
    const searchUrl = `${this.hubApiBaseUrl}/datasets?search=${encodeURIComponent(query)}&limit=${limit}&full=true`;

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
            status: 'degraded',
            result_count: 0,
            warning: `Hugging Face Hub API returned HTTP ${response.status}`,
          },
          datasets: [],
        };
      }

      const rawItems = await response.json<any[]>();
      if (!Array.isArray(rawItems)) {
        return {
          source: this.source,
          status: {
            source: this.source,
            status: 'degraded',
            result_count: 0,
            warning: 'Hugging Face API returned non-array payload',
          },
          datasets: [],
        };
      }

      const datasets: Dataset[] = [];
      const now = new Date().toISOString();

      for (const item of rawItems) {
        // Skip gated or private datasets per plan rules
        if (item.gated || item.private) {
          continue;
        }

        const nativeId = item.id || item._id;
        if (!nativeId || typeof nativeId !== 'string') {
          continue;
        }

        const datasetId = `huggingface:${nativeId}`;
        const sourceUrl = `https://huggingface.co/datasets/${nativeId}`;
        const title = item.description ? nativeId : nativeId.split('/').pop() || nativeId;
        const description = typeof item.description === 'string' && item.description.trim() ? item.description.trim() : null;
        const tags = Array.isArray(item.tags) ? item.tags.filter((t: any) => typeof t === 'string') : [];
        const license = typeof item.license === 'string' ? item.license : null;
        const lastUpdated = item.lastModified ? new Date(item.lastModified).toISOString() : null;

        // Try to retrieve schema info from dataset-viewer API if available
        let columns: string[] = [];
        let recordCount: number | null = null;
        let verificationLevel: Dataset['verification_level'] = 'metadata_only';

        try {
          const infoUrl = `${this.viewerApiBaseUrl}/info?dataset=${encodeURIComponent(nativeId)}`;
          const infoRes = await safeFetch(infoUrl, {
            headers,
            signal: ctx.signal,
            timeoutMs: 4000,
          });

          if (infoRes.status === 200) {
            const infoData = await infoRes.json<any>();
            const datasetInfo = infoData?.dataset_info?.default || Object.values(infoData?.dataset_info || {})[0];
            if (datasetInfo?.features) {
              columns = Object.keys(datasetInfo.features);
            }
            if (typeof datasetInfo?.splits?.train?.num_examples === 'number') {
              recordCount = datasetInfo.splits.train.num_examples;
            }
          }
        } catch {
          // Dataset viewer is optional per plan: fallback to metadata-only
        }

        const provenance: Dataset['provenance'] = {
          title: { source_field_path: 'id', retrieved_at: now },
        };
        if (description) {
          provenance['description'] = { source_field_path: 'description', retrieved_at: now };
        }
        if (license) {
          provenance['license'] = { source_field_path: 'license', retrieved_at: now };
        }
        if (columns.length > 0) {
          provenance['columns'] = { source_field_path: 'viewer.info.features', retrieved_at: now };
        }
        if (recordCount !== null) {
          provenance['record_count'] = { source_field_path: 'viewer.info.splits.train.num_examples', retrieved_at: now };
        }

        datasets.push({
          dataset_id: datasetId,
          source: 'huggingface',
          source_url: sourceUrl,
          title,
          description,
          license,
          access_type: 'open',
          api_endpoint: `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(nativeId)}`,
          file_formats: ['parquet'],
          record_count: recordCount,
          columns,
          geography: null,
          time_coverage: null,
          tags,
          last_updated: lastUpdated,
          retrieved_at: now,
          raw_snapshot_key: null,
          verification_level: verificationLevel,
          provenance,
        });

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
    } catch (err: any) {
      return {
        source: this.source,
        status: {
          source: this.source,
          status: 'failed',
          result_count: 0,
          warning: `Hugging Face search failed: ${err.message}`,
        },
        datasets: [],
      };
    }
  }

  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    if (!datasetId.startsWith('huggingface:')) {
      return null;
    }
    const nativeId = datasetId.slice('huggingface:'.length);
    const detailUrl = `${this.hubApiBaseUrl}/datasets/${encodeURIComponent(nativeId)}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`;
    }

    try {
      const response = await safeFetch(detailUrl, {
        headers,
        signal: ctx.signal,
        timeoutMs: 6000,
      });

      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new Error(`Hub API error ${response.status}`);
      }

      const item = await response.json<any>();
      const now = new Date().toISOString();

      return {
        dataset_id: datasetId,
        source: 'huggingface',
        source_url: `https://huggingface.co/datasets/${nativeId}`,
        title: item.description ? nativeId : nativeId.split('/').pop() || nativeId,
        description: item.description || null,
        license: typeof item.license === 'string' ? item.license : null,
        access_type: 'open',
        api_endpoint: `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(nativeId)}`,
        file_formats: ['parquet'],
        record_count: null,
        columns: [],
        geography: null,
        time_coverage: null,
        tags: Array.isArray(item.tags) ? item.tags : [],
        last_updated: item.lastModified ? new Date(item.lastModified).toISOString() : null,
        retrieved_at: now,
        raw_snapshot_key: null,
        verification_level: 'metadata_only',
        provenance: {
          title: { source_field_path: 'id', retrieved_at: now },
        },
      };
    } catch {
      return null;
    }
  }
}
