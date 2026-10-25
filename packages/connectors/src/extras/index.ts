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

type JsonRecord = Record<string, unknown>;
type SourceState = 'success' | 'failed' | 'disabled';

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function boundedLimit(value: number): number {
  return Math.min(Math.max(Math.floor(value) || 1, 1), 20);
}
function isoDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T00:00:00.000Z`
    : raw;
  return Number.isNaN(Date.parse(normalized))
    ? null
    : new Date(normalized).toISOString();
}
function hostOf(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error(
      'Catalog base URL must be HTTPS and contain no credentials.',
    );
  return url.hostname;
}

abstract class FlaggedConnector implements Connector {
  abstract readonly source: SourceId;
  protected readonly enabled: boolean;
  protected readonly baseUrl: string;
  protected readonly host: string;
  protected constructor(baseUrl: string, enabled: boolean) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.host = hostOf(this.baseUrl);
    this.enabled = enabled;
  }
  protected async json<T>(
    url: string,
    ctx: CallContext,
    maxBytes = 2_000_000,
  ): Promise<{ status: number; body: T }> {
    const response = await safeFetch(url, {
      signal: ctx.signal,
      timeoutMs: 8000,
      maxBytes,
      allowedContentTypes: ['json'],
      ssrfOptions: { allowedHosts: [this.host] },
    });
    return {
      status: response.status,
      body: response.status === 200 ? await response.json<T>() : ({} as T),
    };
  }
  protected result(
    datasets: Dataset[],
    status: SourceState,
    warning: string | null = null,
  ): ConnectorSearchResult {
    return {
      source: this.source,
      datasets,
      status: {
        source: this.source,
        status,
        result_count: datasets.length,
        warning,
      },
    };
  }
  protected disabled(): ConnectorSearchResult {
    return this.result([], 'disabled', 'This optional source is disabled.');
  }
  abstract search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult>;
  abstract getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null>;
}

export interface UciConnectorOptions {
  enabled?: boolean;
  baseUrl?: string;
}
/** Optional UCI adapter. Metadata is from the UCI catalog; it does not download dataset files. */
export class UciConnector extends FlaggedConnector {
  readonly source: SourceId = 'uci';
  constructor(options: UciConnectorOptions = {}) {
    super(
      options.baseUrl ?? 'https://archive.ics.uci.edu/api',
      options.enabled ?? false,
    );
  }
  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    if (!this.enabled) return this.disabled();
    const query = req.requirements.topic?.trim();
    if (!query) return this.result([], 'success');
    try {
      const url = new URL(`${this.baseUrl}/datasets/list`);
      url.searchParams.set('filter', 'python');
      url.searchParams.set('search', query);
      const { status, body } = await this.json<JsonRecord>(url.href, ctx);
      if (status !== 200)
        return this.result([], 'failed', `UCI returned HTTP ${status}`);
      const dataValue = body['data'];
      const data = record(dataValue);
      const rows = Array.isArray(dataValue)
        ? dataValue
        : list(data['datasets'] ?? data['items'] ?? body['datasets']);
      const datasets: Dataset[] = [];
      for (const rowValue of rows.slice(0, boundedLimit(req.maxResults))) {
        const row = record(rowValue);
        const id = String(row['id'] ?? row['dataset_id'] ?? '');
        if (!/^\d+$/.test(id)) continue;
        const dataset = await this.fetchDetails(id, ctx);
        if (dataset) datasets.push(dataset);
      }
      return this.result(datasets, 'success');
    } catch (error) {
      return this.result(
        [],
        'failed',
        error instanceof Error ? error.message : 'UCI request failed',
      );
    }
  }
  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    const id = datasetId.startsWith('uci:') ? datasetId.slice(4) : '';
    return /^\d+$/.test(id) ? this.fetchDetails(id, ctx) : null;
  }
  private async fetchDetails(
    id: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    const url = new URL(`${this.baseUrl}/dataset`);
    url.searchParams.set('id', id);
    const { status, body } = await this.json<JsonRecord>(url.href, ctx);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`UCI dataset returned HTTP ${status}`);
    if (Number(body['status']) !== 200) return null;
    const data = record(body['data']);
    const metadata = record(body['metadata'] ?? data);
    const variables = list(
      body['variables'] ?? metadata['variables'] ?? data['variables'],
    ).map(record);
    const name = text(metadata['name'] ?? data['name']);
    if (!name) return null;
    const count = Number(metadata['num_instances'] ?? metadata['instances']);
    const cols = variables
      .map((variable) => text(variable['name']))
      .filter((value): value is string => value !== null);
    const raw: RawCandidate = {
      source: 'uci',
      native_id: id,
      source_url: `https://archive.ics.uci.edu/datasets/${id}`,
      title: name,
      description: text(metadata['abstract'] ?? metadata['description']),
      license: text(metadata['license']),
      access_type: 'open',
      api_endpoint: `${this.baseUrl}/dataset?id=${encodeURIComponent(id)}`,
      file_formats: ['csv'],
      record_count: Number.isSafeInteger(count) && count >= 0 ? count : null,
      columns: cols,
      geography: null,
      time_coverage: null,
      tags: [
        text(metadata['area']),
        text(metadata['tasks']),
        text(metadata['characteristics']),
      ].filter((value): value is string => value !== null),
      last_updated: null,
      verification_level: 'metadata_only',
      field_paths: {
        title: 'metadata.name',
        description: 'metadata.abstract',
        license: 'metadata.license',
        record_count: 'metadata.num_instances',
        columns: 'variables[].name',
        tags: 'metadata.area/tasks/characteristics',
      },
    };
    return normalizeDataset(raw).dataset;
  }
}

export interface ZenodoConnectorOptions {
  enabled?: boolean;
  baseUrl?: string;
}
type ZenodoRecord = {
  id?: number | string;
  doi?: string;
  links?: { html?: string; self?: string };
  metadata?: JsonRecord;
  files?: Array<{
    key?: string;
    type?: string;
    size?: number;
    checksum?: string;
  }>;
};
/** Optional Zenodo records search; supports discovery metadata only and never downloads record files. */
export class ZenodoConnector extends FlaggedConnector {
  readonly source: SourceId = 'zenodo';
  constructor(options: ZenodoConnectorOptions = {}) {
    super(
      options.baseUrl ?? 'https://zenodo.org/api',
      options.enabled ?? false,
    );
  }
  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    if (!this.enabled) return this.disabled();
    const topic = req.requirements.topic?.trim();
    if (!topic) return this.result([], 'success');
    try {
      const url = new URL(`${this.baseUrl}/records`);
      url.searchParams.set('q', `resource_type.type:dataset AND (${topic})`);
      url.searchParams.set('size', String(boundedLimit(req.maxResults)));
      url.searchParams.set('sort', 'bestmatch');
      const { status, body } = await this.json<JsonRecord>(url.href, ctx);
      if (status !== 200)
        return this.result([], 'failed', `Zenodo returned HTTP ${status}`);
      const hits = record(body['hits']);
      const items = list(hits['hits'] ?? body['results'])
        .map((item) => this.toDataset(record(item)))
        .filter((item): item is Dataset => item !== null);
      return this.result(
        items.slice(0, boundedLimit(req.maxResults)),
        'success',
      );
    } catch (error) {
      return this.result(
        [],
        'failed',
        error instanceof Error ? error.message : 'Zenodo request failed',
      );
    }
  }
  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    const id = datasetId.startsWith('zenodo:') ? datasetId.slice(7) : '';
    if (!/^\d+$/.test(id)) return null;
    const { status, body } = await this.json<ZenodoRecord>(
      `${this.baseUrl}/records/${encodeURIComponent(id)}`,
      ctx,
    );
    if (status === 404) return null;
    if (status !== 200)
      throw new Error(`Zenodo record returned HTTP ${status}`);
    return this.toDataset(body);
  }
  private toDataset(item: ZenodoRecord): Dataset | null {
    const metadata = record(item.metadata);
    const id = String(item.id ?? '');
    const title = text(metadata['title']);
    if (!/^\d+$/.test(id) || !title) return null;
    const fileList = list(item.files).map((file) => record(file));
    const formats = [
      ...new Set(
        fileList
          .map((file) => {
            const name = text(file['key']);
            return name?.includes('.')
              ? (name.split('.').pop()?.toLowerCase() ?? null)
              : text(file['type']);
          })
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const access = record(metadata['access_right']);
    const license = record(metadata['license']);
    const date = text(
      metadata['publication_date'] ?? metadata['imprint_published'],
    );
    const raw: RawCandidate = {
      source: 'zenodo',
      native_id: id,
      source_url: text(item.links?.html) ?? `https://zenodo.org/records/${id}`,
      title,
      description: text(metadata['description']),
      license: text(license['id'] ?? license['title']),
      access_type:
        text(metadata['access_right']) ??
        text(access['title'] ?? access['classification']) ??
        'unknown',
      api_endpoint:
        text(item.links?.self) ?? `https://zenodo.org/api/records/${id}`,
      file_formats: formats,
      record_count: null,
      columns: [],
      tags: list(metadata['keywords']).filter(
        (tag): tag is string => typeof tag === 'string',
      ),
      last_updated: isoDate(date),
      verification_level: 'metadata_only',
      field_paths: {
        title: 'metadata.title',
        description: 'metadata.description',
        license: 'metadata.license',
        access_type: 'metadata.access_right',
        file_formats: 'files[].key',
        tags: 'metadata.keywords',
      },
    };
    return normalizeDataset(raw).dataset;
  }
}

export interface DataverseConnectorOptions {
  enabled?: boolean;
  baseUrl?: string;
}
type DataverseItem = {
  entityId?: number;
  global_id?: string;
  name?: string;
  description?: string;
  url?: string;
  published_at?: string;
};
/** Optional Harvard Dataverse adapter. Restricted-file datasets are omitted. */
export class DataverseConnector extends FlaggedConnector {
  readonly source: SourceId = 'dataverse';
  constructor(options: DataverseConnectorOptions = {}) {
    super(
      options.baseUrl ?? 'https://dataverse.harvard.edu',
      options.enabled ?? false,
    );
  }
  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    if (!this.enabled) return this.disabled();
    const topic = req.requirements.topic?.trim();
    if (!topic) return this.result([], 'success');
    try {
      const url = new URL(`${this.baseUrl}/api/search`);
      url.searchParams.set('q', topic);
      url.searchParams.set('type', 'dataset');
      url.searchParams.set('per_page', String(boundedLimit(req.maxResults)));
      url.searchParams.set('show_entity_ids', 'true');
      const { status, body } = await this.json<JsonRecord>(url.href, ctx);
      if (status !== 200)
        return this.result([], 'failed', `Dataverse returned HTTP ${status}`);
      const data = record(body['data']);
      const items = list(data['items']).map(record);
      const results: Dataset[] = [];
      for (const item of items.slice(0, boundedLimit(req.maxResults))) {
        const id = String(item['entityId'] ?? item['entity_id'] ?? '');
        if (!/^\d+$/.test(id) || item['type'] !== 'dataset') continue;
        const dataset = await this.fetchDataset(id, item as DataverseItem, ctx);
        if (dataset) results.push(dataset);
      }
      return this.result(results, 'success');
    } catch (error) {
      return this.result(
        [],
        'failed',
        error instanceof Error ? error.message : 'Dataverse request failed',
      );
    }
  }
  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    const entityId = datasetId.startsWith('dataverse:')
      ? datasetId.slice(10)
      : '';
    if (!/^\d+$/.test(entityId)) return null;
    return this.fetchDataset(entityId, {}, ctx);
  }
  private async fetchDataset(
    entityId: string,
    searchItem: DataverseItem,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    const url = `${this.baseUrl}/api/datasets/${encodeURIComponent(entityId)}/versions/:latest-published?excludeFiles=false`;
    const { status, body } = await this.json<JsonRecord>(url, ctx, 3_000_000);
    if (status === 404) return null;
    if (status !== 200)
      throw new Error(`Dataverse dataset returned HTTP ${status}`);
    const data = record(body['data']);
    const files = list(data['files']).map(record);
    const restricted = files.some((file) => {
      const fileData = record(file['dataFile']);
      const restrictedFlag = fileData['restricted'];
      return (
        restrictedFlag === true ||
        record(file['directoryLabel'])['restricted'] === true
      );
    });
    if (restricted) return null;
    const metadataBlocks = record(data['metadataBlocks']);
    const citation = record(metadataBlocks['citation']);
    const citationFields = list(citation['fields']).map(record);
    const titleField = citationFields.find(
      (field) => field['typeName'] === 'title',
    );
    const descriptionField = citationFields.find(
      (field) => field['typeName'] === 'dsDescription',
    );
    const title = text(titleField?.['value'] ?? searchItem.name);
    if (!title) return null;
    const descEntry = list(descriptionField?.['value']).map(record)[0];
    const descValue = record(descEntry?.['dsDescriptionValue']);
    const fileFormats = [
      ...new Set(
        files
          .map((file) => {
            const dataFile = record(file['dataFile']);
            const name = text(dataFile['filename']);
            return name?.includes('.')
              ? (name.split('.').pop()?.toLowerCase() ?? null)
              : null;
          })
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const persistentId = text(
      data['datasetPersistentId'] ?? searchItem.global_id,
    );
    const raw: RawCandidate = {
      source: 'dataverse',
      native_id: entityId,
      source_url: persistentId
        ? `${this.baseUrl}/dataset.xhtml?persistentId=${encodeURIComponent(persistentId)}`
        : `${this.baseUrl}/api/datasets/${encodeURIComponent(entityId)}`,
      title,
      description: text(descValue['value'] ?? searchItem.description),
      license: null,
      access_type: 'open',
      api_endpoint: url,
      file_formats: fileFormats,
      record_count: null,
      columns: [],
      geography: null,
      time_coverage: null,
      tags: [],
      last_updated: text(data['publicationDate'] ?? searchItem.published_at),
      verification_level: 'metadata_only',
      field_paths: {
        title: 'metadataBlocks.citation.fields.title.value',
        description: 'metadataBlocks.citation.fields.dsDescription',
        file_formats: 'files[].dataFile.filename',
        last_updated: 'publicationDate',
      },
    };
    return normalizeDataset(raw).dataset;
  }
}

export interface CkanPortal {
  id: string;
  baseUrl: string;
}
export interface CkanConnectorOptions {
  portals: CkanPortal[];
  enabled?: boolean;
}
type CkanPackage = {
  id?: string;
  name?: string;
  title?: string;
  notes?: string;
  license_title?: string;
  metadata_modified?: string;
  tags?: Array<{ name?: string }>;
  resources?: Array<{ format?: string; url?: string }>;
};
/** Optional generic CKAN adapter. Every portal must be explicitly configured and host-allowlisted. */
export class CkanConnector implements Connector {
  readonly source: SourceId = 'ckan';
  private readonly portals: Map<string, { baseUrl: string; host: string }>;
  private readonly enabled: boolean;
  constructor(options: CkanConnectorOptions) {
    this.enabled = options.enabled ?? false;
    this.portals = new Map(
      options.portals
        .filter((portal) => /^[a-z0-9_-]{1,40}$/.test(portal.id))
        .map((portal) => [
          portal.id,
          {
            baseUrl: portal.baseUrl.replace(/\/$/, ''),
            host: hostOf(portal.baseUrl),
          },
        ]),
    );
  }
  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    if (!this.enabled)
      return {
        source: this.source,
        datasets: [],
        status: {
          source: this.source,
          status: 'disabled',
          result_count: 0,
          warning: 'This optional source is disabled.',
        },
      };
    const query = req.requirements.topic?.trim();
    if (!query) return this.result([]);
    try {
      const results: Dataset[] = [];
      let failures = 0;
      for (const [portalId, portal] of this.portals) {
        if (results.length >= boundedLimit(req.maxResults)) break;
        const url = new URL(`${portal.baseUrl}/api/3/action/package_search`);
        url.searchParams.set('q', query);
        url.searchParams.set(
          'rows',
          String(boundedLimit(req.maxResults) - results.length),
        );
        try {
          const response = await safeFetch(url.href, {
            signal: ctx.signal,
            timeoutMs: 8000,
            maxBytes: 2_000_000,
            maxRedirects: 0,
            allowedContentTypes: ['json'],
            ssrfOptions: { allowedHosts: [portal.host] },
          });
          if (response.status !== 200) {
            failures++;
            continue;
          }
          const payload = record(await response.json<unknown>());
          const data = record(payload['result']);
          for (const item of list(data['results']).map((value) =>
            record(value),
          ) as CkanPackage[]) {
            const dataset = this.toDataset(portalId, portal.baseUrl, item);
            if (dataset) results.push(dataset);
            if (results.length >= boundedLimit(req.maxResults)) break;
          }
        } catch {
          failures++;
        }
      }
      const status =
        failures === 0 ? 'success' : results.length ? 'partial' : 'failed';
      const warning = failures
        ? `${failures} configured CKAN portal${failures === 1 ? '' : 's'} failed.`
        : null;
      return {
        source: this.source,
        datasets: results,
        status: {
          source: this.source,
          status,
          result_count: results.length,
          warning,
        },
      };
    } catch (error) {
      return {
        source: this.source,
        datasets: [],
        status: {
          source: this.source,
          status: 'failed',
          result_count: 0,
          warning:
            error instanceof Error ? error.message : 'CKAN request failed',
        },
      };
    }
  }
  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    const match = /^ckan:([a-z0-9_-]+)\/(.+)$/.exec(datasetId);
    if (!match) return null;
    const portalId = match[1]!;
    const packageId = match[2]!;
    const portal = this.portals.get(portalId);
    if (!portal) return null;
    const url = new URL(`${portal.baseUrl}/api/3/action/package_show`);
    url.searchParams.set('id', packageId);
    const response = await safeFetch(url.href, {
      signal: ctx.signal,
      timeoutMs: 8000,
      maxBytes: 2_000_000,
      maxRedirects: 0,
      allowedContentTypes: ['json'],
      ssrfOptions: { allowedHosts: [portal.host] },
    });
    if (response.status === 404) return null;
    if (response.status !== 200)
      throw new Error(`CKAN package returned HTTP ${response.status}`);
    const payload = record(await response.json<unknown>());
    return this.toDataset(portalId, portal.baseUrl, record(payload['result']));
  }
  private toDataset(
    portalId: string,
    baseUrl: string,
    item: CkanPackage,
  ): Dataset | null {
    const id = text(item.id ?? item.name);
    const title = text(item.title ?? item.name);
    if (!id || !title) return null;
    const formats = [
      ...new Set(
        list(item.resources)
          .map((resource) => text(record(resource)['format']))
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    return normalizeDataset({
      source: 'ckan',
      native_id: `${portalId}/${id}`,
      source_url: `${baseUrl}/dataset/${encodeURIComponent(item.name ?? id)}`,
      title,
      description: text(item.notes),
      license: text(item.license_title),
      access_type: 'open',
      api_endpoint: `${baseUrl}/api/3/action/package_show?id=${encodeURIComponent(id)}`,
      file_formats: formats,
      record_count: null,
      columns: [],
      tags: list(item.tags)
        .map((tag) => text(record(tag)['name']))
        .filter((value): value is string => Boolean(value)),
      last_updated: text(item.metadata_modified),
      verification_level: 'metadata_only',
      field_paths: {
        title: 'result.title',
        description: 'result.notes',
        license: 'result.license_title',
        file_formats: 'result.resources[].format',
        tags: 'result.tags[].name',
        last_updated: 'result.metadata_modified',
      },
    }).dataset;
  }
  private result(datasets: Dataset[]): ConnectorSearchResult {
    return {
      source: this.source,
      datasets,
      status: {
        source: this.source,
        status: 'success',
        result_count: datasets.length,
        warning: null,
      },
    };
  }
}
