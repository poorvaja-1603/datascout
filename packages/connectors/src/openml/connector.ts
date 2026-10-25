import type {
  CallContext,
  Connector,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  Dataset,
  SourceId,
} from '@datascout/contracts';
import { normalizeDataset } from '../normalize/index.js';
import type { RawCandidate } from '../normalize/index.js';
import { safeFetch } from '../toolkit/safe-fetch.js';

export interface OpenMLConnectorOptions {
  baseUrl?: string;
}
interface OpenMLList {
  data?: { dataset?: Array<Record<string, unknown>> };
}
interface OpenMLDetail {
  data_set_description?: Record<string, unknown>;
}
interface OpenMLQuality {
  qualities?: { quality?: Array<{ name?: string; value?: string | number }> };
}
interface OpenMLFeatures {
  data_features?: { feature?: Array<{ name?: string }> };
}

/** Read-only OpenML adapter. Source-provided descriptions and licenses remain claims, not verification. */
export class OpenMLConnector implements Connector {
  readonly source: SourceId = 'openml';
  private readonly baseUrl: string;
  constructor(options: OpenMLConnectorOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://www.openml.org/api/v1').replace(
      /\/$/,
      '',
    );
  }

  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    const query = req.requirements.topic?.trim();
    if (!query) return this.result([], 'success', null);
    try {
      const url = `${this.baseUrl}/data/list/data_name/${encodeURIComponent(query)}/limit/${Math.min(Math.max(req.maxResults, 1), 20)}/status/active`;
      const response = await safeFetch(url, {
        signal: ctx.signal,
        timeoutMs: 8000,
        maxBytes: 2_000_000,
        allowedContentTypes: ['json'],
      });
      if (response.status !== 200)
        return this.result(
          [],
          'failed',
          `OpenML returned HTTP ${response.status}`,
        );
      const payload = await response.json<OpenMLList>();
      const entries = payload.data?.dataset ?? [];
      const datasets: Dataset[] = [];
      for (const entry of entries.slice(
        0,
        Math.min(Math.max(req.maxResults, 1), 20),
      )) {
        const id = String(entry.did ?? '');
        if (!/^\d+$/.test(id)) continue;
        const candidate = await this.getRawDetails(id, ctx);
        if (candidate) datasets.push(normalizeDataset(candidate).dataset);
      }
      return this.result(datasets, 'success', null);
    } catch (error) {
      return this.result(
        [],
        'failed',
        error instanceof Error ? error.message : 'OpenML request failed',
      );
    }
  }

  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    const id = datasetId.startsWith('openml:') ? datasetId.slice(7) : '';
    if (!/^\d+$/.test(id)) return null;
    const raw = await this.getRawDetails(id, ctx);
    return raw ? normalizeDataset(raw).dataset : null;
  }

  private async getRawDetails(
    id: string,
    ctx: CallContext,
  ): Promise<RawCandidate | null> {
    const response = await safeFetch(
      `${this.baseUrl}/data/${encodeURIComponent(id)}`,
      {
        signal: ctx.signal,
        timeoutMs: 6000,
        maxBytes: 1_000_000,
        allowedContentTypes: ['json'],
      },
    );
    if (response.status === 404) return null;
    if (response.status !== 200)
      throw new Error(`OpenML detail returned HTTP ${response.status}`);
    const payload = await response.json<OpenMLDetail>();
    return payload.data_set_description
      ? this.toCandidate(id, payload.data_set_description, ctx)
      : null;
  }

  private async toCandidate(
    id: string,
    item: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<RawCandidate> {
    let qualities: OpenMLQuality = {};
    try {
      const response = await safeFetch(
        `${this.baseUrl}/data/qualities/${encodeURIComponent(id)}?format=json`,
        {
          signal: ctx.signal,
          timeoutMs: 4000,
          maxBytes: 500_000,
          allowedContentTypes: ['json'],
        },
      );
      if (response.status === 200)
        qualities = await response.json<OpenMLQuality>();
    } catch {
      /* quality metadata is optional */
    }
    let columns: string[] = [];
    try {
      const response = await safeFetch(
        `${this.baseUrl}/data/features/${encodeURIComponent(id)}?format=json`,
        {
          signal: ctx.signal,
          timeoutMs: 4000,
          maxBytes: 1_000_000,
          allowedContentTypes: ['json'],
        },
      );
      if (response.status === 200) {
        const payload = await response.json<OpenMLFeatures>();
        columns = (payload.data_features?.feature ?? [])
          .map((feature) => feature.name ?? '')
          .filter(Boolean);
      }
    } catch {
      /* feature metadata is optional */
    }
    const quality = new Map(
      (qualities.qualities?.quality ?? []).map((q) => [q.name ?? '', q.value]),
    );
    const count = Number(quality.get('NumberOfInstances'));
    return {
      source: 'openml',
      native_id: id,
      source_url: `https://www.openml.org/d/${id}`,
      title: typeof item.name === 'string' ? item.name : `OpenML dataset ${id}`,
      description:
        typeof item.description === 'string' ? item.description : null,
      license:
        typeof item.licence === 'string'
          ? item.licence
          : typeof item.license === 'string'
            ? item.license
            : null,
      access_type: 'open',
      api_endpoint: `${this.baseUrl}/data/${id}`,
      file_formats: ['arff'],
      record_count: Number.isSafeInteger(count) && count >= 0 ? count : null,
      columns,
      tags:
        typeof item.tag === 'string' ? item.tag.split(',').filter(Boolean) : [],
      last_updated:
        typeof item.version_date === 'string' ? item.version_date : null,
      verification_level: 'metadata_only',
      field_paths: {
        title: 'data_set_description.name',
        description: 'data_set_description.description',
        license: 'data_set_description.licence',
        columns: 'features.feature.name',
        record_count: 'qualities.NumberOfInstances',
        tags: 'data_set_description.tag',
      },
    };
  }

  private result(
    datasets: Dataset[],
    status: 'success' | 'failed',
    warning: string | null,
  ): ConnectorSearchResult {
    return {
      source: this.source,
      status: {
        source: this.source,
        status,
        result_count: datasets.length,
        warning,
      },
      datasets,
    };
  }
}
