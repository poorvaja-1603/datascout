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
import { normalizeDataset } from '../normalize/index.js';
import type { RawCandidate } from '../normalize/index.js';
import { inspectBytes } from '../inspect/inspector.js';

export interface HuggingFaceConnectorOptions {
  hubApiBaseUrl?: string;
  viewerApiBaseUrl?: string;
  apiToken?: string;
}

interface HubItem {
  id?: string;
  _id?: string;
  description?: string;
  tags?: string[];
  license?: string;
  lastModified?: string;
  gated?: boolean;
  private?: boolean;
}

interface ViewerDatasetInfo {
  features?: Record<string, { dtype?: string }>;
  splits?: { train?: { num_examples?: number } };
}

interface ViewerInfoResponse {
  dataset_info?: Record<string, ViewerDatasetInfo>;
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
    this.apiToken = options.apiToken ?? process.env['HUGGINGFACE_API_TOKEN'];
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
            status: 'failed',
            result_count: 0,
            warning: `Hugging Face Hub API returned HTTP ${response.status}`,
          },
          datasets: [],
        };
      }

      const rawItems = await response.json<HubItem[]>();
      if (!Array.isArray(rawItems)) {
        return {
          source: this.source,
          status: {
            source: this.source,
            status: 'failed',
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

        const sourceUrl = `https://huggingface.co/datasets/${nativeId}`;
        const title = item.description
          ? nativeId
          : nativeId.split('/').pop() || nativeId;
        const description =
          typeof item.description === 'string' && item.description.trim()
            ? item.description.trim()
            : null;
        const tags = Array.isArray(item.tags)
          ? item.tags.filter((t): t is string => typeof t === 'string')
          : [];
        const license = typeof item.license === 'string' ? item.license : null;
        const lastUpdated = item.lastModified
          ? new Date(item.lastModified).toISOString()
          : null;

        // Try to retrieve schema info from dataset-viewer API if available
        let columns: string[] = [];
        let recordCount: number | null = null;
        const verificationLevel: Dataset['verification_level'] =
          'metadata_only';

        try {
          const infoUrl = `${this.viewerApiBaseUrl}/info?dataset=${encodeURIComponent(nativeId)}`;
          const infoRes = await safeFetch(infoUrl, {
            headers,
            signal: ctx.signal,
            timeoutMs: 4000,
          });

          if (infoRes.status === 200) {
            const infoData = await infoRes.json<ViewerInfoResponse>();
            const datasetInfo: ViewerDatasetInfo | undefined =
              infoData?.dataset_info?.default ??
              Object.values(infoData?.dataset_info ?? {})[0];
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

        const rawCandidate: RawCandidate = {
          source: 'huggingface',
          native_id: nativeId,
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
          raw_snapshot_key: null,
          verification_level: verificationLevel,
          field_paths: {
            title: 'id',
            description: 'description',
            license: 'license',
            columns: 'viewer.info.features',
            record_count: 'viewer.info.splits.train.num_examples',
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
          warning: `Hugging Face search failed: ${message}`,
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

      const item = await response.json<HubItem>();
      const now = new Date().toISOString();

      const rawCandidate: RawCandidate = {
        source: 'huggingface',
        native_id: nativeId,
        source_url: `https://huggingface.co/datasets/${nativeId}`,
        title: item.description
          ? nativeId
          : nativeId.split('/').pop() || nativeId,
        description: item.description || null,
        license: typeof item.license === 'string' ? item.license : null,
        access_type: 'open',
        api_endpoint: `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(nativeId)}`,
        file_formats: ['parquet'],
        record_count: null,
        columns: [],
        geography: null,
        time_coverage: null,
        tags: Array.isArray(item.tags)
          ? item.tags.filter((t): t is string => typeof t === 'string')
          : [],
        last_updated: item.lastModified
          ? new Date(item.lastModified).toISOString()
          : null,
        raw_snapshot_key: null,
        verification_level: 'metadata_only',
        field_paths: {
          title: 'id',
          description: 'description',
          license: 'license',
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
    limits: InspectionLimits,
    ctx: CallContext,
  ): Promise<SampleInspection> {
    const empty = (status: SampleInspection['status']): SampleInspection => ({
      datasetId: dataset.dataset_id,
      status,
      verificationLevel: 'metadata_only',
      rowsExamined: 0,
      columns: [],
      dateRange: null,
      duplicateRate: null,
      evidence: [],
    });
    const nativeId = dataset.dataset_id.startsWith('huggingface:')
      ? dataset.dataset_id.slice('huggingface:'.length)
      : '';
    if (!nativeId || ctx.signal.aborted) return empty('failed');

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
    try {
      const splitsUrl = new URL(`${this.viewerApiBaseUrl}/splits`);
      splitsUrl.searchParams.set('dataset', nativeId);
      const splitsResponse = await safeFetch(splitsUrl.toString(), {
        headers,
        signal: ctx.signal,
        timeoutMs: Math.min(limits.timeoutMs, 3000),
        maxBytes: 256 * 1024,
        allowedContentTypes: ['application/json'],
      });
      if (splitsResponse.status !== 200) return empty('failed');
      const splitPayload = await splitsResponse.json<{
        splits?: Array<{ config?: string; split?: string }>;
      }>();
      const firstSplit = splitPayload.splits?.find(
        (item) => item.config && item.split,
      );
      if (!firstSplit?.config || !firstSplit.split) return empty('failed');

      const rowsUrl = new URL(`${this.viewerApiBaseUrl}/rows`);
      rowsUrl.searchParams.set('dataset', nativeId);
      rowsUrl.searchParams.set('config', firstSplit.config);
      rowsUrl.searchParams.set('split', firstSplit.split);
      rowsUrl.searchParams.set('offset', '0');
      rowsUrl.searchParams.set('length', String(Math.min(limits.maxRows, 500)));
      const response = await safeFetch(rowsUrl.toString(), {
        headers,
        signal: ctx.signal,
        timeoutMs: limits.timeoutMs,
        maxBytes: limits.maxBytes,
        allowedContentTypes: ['application/json'],
      });
      if (response.status !== 200) return empty('failed');
      const payload = await response.json<{
        rows?: Array<{ row?: Record<string, unknown> }>;
      }>();
      const rows = Array.isArray(payload.rows)
        ? payload.rows.flatMap((item) =>
            item && typeof item.row === 'object' && item.row !== null
              ? [item.row]
              : [],
          )
        : [];
      if (rows.length === 0) return empty('failed');
      const bytes = new TextEncoder().encode(JSON.stringify(rows));
      return await inspectBytes(dataset, bytes, {
        contentType: 'application/json',
        filename: `${nativeId.replaceAll('/', '_')}.json`,
        limits,
        signal: ctx.signal,
        deadlineMs: ctx.deadlineMs,
      });
    } catch {
      return empty('failed');
    }
  }
}
