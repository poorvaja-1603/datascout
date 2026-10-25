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

export interface WorldBankConnectorOptions {
  baseUrl?: string;
  countries?: string[];
}
type IndicatorRow = {
  id?: string;
  name?: string;
  source?: { value?: string };
  topics?: Array<{ value?: string }>;
};

/** Indicator catalog adapter. World Bank observations have country-year grain, not row-level ML records. */
export class WorldBankConnector implements Connector {
  readonly source: SourceId = 'worldbank';
  private readonly baseUrl: string;
  private readonly countries: string[];
  constructor(options: WorldBankConnectorOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.worldbank.org/v2').replace(
      /\/$/,
      '',
    );
    this.countries = options.countries?.length ? options.countries : ['all'];
  }

  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    const query = req.requirements.topic?.trim();
    if (!query) return this.result([], 'success', null);
    try {
      const limit = Math.min(Math.max(req.maxResults, 1), 20);
      const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const candidates: IndicatorRow[] = [];
      // Keep discovery bounded while paging past the first slice of the catalog.
      for (let page = 1; page <= 5 && candidates.length < limit; page++) {
        const response = await safeFetch(
          `${this.baseUrl}/indicator?format=json&per_page=100&page=${page}`,
          {
            signal: ctx.signal,
            timeoutMs: 8000,
            maxBytes: 3_000_000,
            allowedContentTypes: ['json'],
          },
        );
        if (response.status !== 200)
          return this.result(
            [],
            'failed',
            `World Bank returned HTTP ${response.status}`,
          );
        const body = await response.json<unknown>();
        const rows =
          Array.isArray(body) && Array.isArray(body[1])
            ? (body[1] as IndicatorRow[])
            : [];
        candidates.push(
          ...rows.filter((r) => {
            const haystack =
              `${r.name ?? ''} ${(r.topics ?? []).map((t) => t.value ?? '').join(' ')}`.toLocaleLowerCase();
            return words.some((word) => haystack.includes(word));
          }),
        );
        if (
          !rows.length ||
          (Array.isArray(body) &&
            typeof body[0] === 'object' &&
            body[0] !== null &&
            Number((body[0] as { pages?: unknown }).pages) <= page)
        )
          break;
      }
      candidates.splice(limit);
      const datasets = candidates
        .filter((r): r is IndicatorRow & { id: string; name: string } =>
          Boolean(r.id && r.name),
        )
        .map((r) => {
          const raw: RawCandidate = {
            source: 'worldbank',
            native_id: r.id,
            source_url: `https://data.worldbank.org/indicator/${encodeURIComponent(r.id)}`,
            title: r.name,
            description:
              'World Bank indicator time series; observations are country-year values and are not row-level machine-learning records.',
            license: null,
            access_type: 'open',
            api_endpoint: `${this.baseUrl}/country/${this.countries.join(';')}/indicator/${encodeURIComponent(r.id)}?format=json`,
            file_formats: ['json'],
            record_count: null,
            columns: ['country', 'year', 'value'],
            geography: this.countries.includes('all')
              ? null
              : this.countries.join(', '),
            time_coverage: null,
            tags: (r.topics ?? []).map((t) => t.value ?? '').filter(Boolean),
            last_updated: null,
            verification_level: 'metadata_only',
            field_paths: { title: 'indicator.name', tags: 'indicator.topics' },
          };
          return normalizeDataset(raw).dataset;
        });
      return this.result(datasets, 'success', null);
    } catch (error) {
      return this.result(
        [],
        'failed',
        error instanceof Error ? error.message : 'World Bank request failed',
      );
    }
  }

  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    const indicator = datasetId.startsWith('worldbank:')
      ? datasetId.slice(9)
      : '';
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(indicator)) return null;
    const url = `${this.baseUrl}/indicator/${encodeURIComponent(indicator)}?format=json`;
    const response = await safeFetch(url, {
      signal: ctx.signal,
      timeoutMs: 6000,
      maxBytes: 1_000_000,
      allowedContentTypes: ['json'],
    });
    if (response.status === 404) return null;
    if (response.status !== 200)
      throw new Error(`World Bank indicator returned HTTP ${response.status}`);
    const body = await response.json<unknown>();
    const rows =
      Array.isArray(body) && Array.isArray(body[1])
        ? (body[1] as IndicatorRow[])
        : [];
    const row = rows.find((r) => r.id === indicator && r.name);
    if (!row?.id || !row.name) return null;
    return normalizeDataset({
      source: 'worldbank',
      native_id: row.id,
      source_url: `https://data.worldbank.org/indicator/${encodeURIComponent(row.id)}`,
      title: row.name,
      description:
        'World Bank indicator time series; observations are country-year values and are not row-level machine-learning records.',
      access_type: 'open',
      api_endpoint: `${this.baseUrl}/country/${this.countries.join(';')}/indicator/${encodeURIComponent(row.id)}?format=json`,
      file_formats: ['json'],
      columns: ['country', 'year', 'value'],
      tags: (row.topics ?? []).map((t) => t.value ?? '').filter(Boolean),
      verification_level: 'metadata_only',
      field_paths: { title: 'indicator.name', tags: 'indicator.topics' },
    }).dataset;
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
