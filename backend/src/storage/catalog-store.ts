import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

type CatalogWriteRequest =
  | { PutRequest: { Item: Record<string, string | number | boolean | undefined> } }
  | { DeleteRequest: { Key: Record<string, string> } };

async function batchWriteWithRetry(
  client: DynamoDBDocumentClient,
  tableName: string,
  requests: CatalogWriteRequest[],
): Promise<void> {
  let pending = requests;
  for (let attempt = 0; pending.length > 0 && attempt < 5; attempt += 1) {
    const response = await client.send(new BatchWriteCommand({
      RequestItems: { [tableName]: pending },
    }));
    pending = (response.UnprocessedItems?.[tableName] ?? []) as CatalogWriteRequest[];
    if (pending.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1600)));
    }
  }
  if (pending.length > 0) throw new Error('Catalog batch write left unprocessed items.');
}

export interface CatalogEntry {
  id: string;
  title: string;
  desc: string;
  sector?: string | undefined;
  org?: string | undefined;
  geography?: string | undefined;
}

export interface CatalogStore {
  replaceSource(source: string, entries: CatalogEntry[]): Promise<void>;
  listSource(source: string, limit: number): Promise<CatalogEntry[]>;
  putRefreshStatus(source: string, status: RefreshSourceStatus): Promise<void>;
  getRefreshStatus(source: string): Promise<RefreshSourceStatus | null>;
}

export interface RefreshSourceStatus {
  status: 'success' | 'partial' | 'failed';
  records: number;
  timestamp: string;
  warning?: string;
}

export class InMemoryCatalogStore implements CatalogStore {
  private readonly entries = new Map<string, CatalogEntry[]>();
  private readonly statuses = new Map<string, RefreshSourceStatus>();

  async replaceSource(source: string, entries: CatalogEntry[]): Promise<void> {
    this.entries.set(source, [...new Map(entries.map((entry) => [entry.id, entry])).values()]);
  }

  async listSource(source: string, limit: number): Promise<CatalogEntry[]> {
    return (this.entries.get(source) ?? []).slice(0, limit);
  }

  async putRefreshStatus(source: string, status: RefreshSourceStatus): Promise<void> {
    this.statuses.set(source, status);
  }

  async getRefreshStatus(source: string): Promise<RefreshSourceStatus | null> {
    return this.statuses.get(source) ?? null;
  }
}

export class DynamoDbCatalogStore implements CatalogStore {
  private readonly client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  constructor(private readonly tableName = process.env.CATALOG_TABLE_NAME ?? 'datascout-catalog-dev') {}

  async replaceSource(source: string, entries: CatalogEntry[]): Promise<void> {
    // Stable keys make refresh idempotent. Upsert first, then remove stale IDs
    // so a shorter refresh cannot leave the searchable index above its cap.
    const uniqueEntries = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
    const retrievedAt = new Date().toISOString();
    const writes: CatalogWriteRequest[] = uniqueEntries.map((entry) => ({
      PutRequest: { Item: { pk: source, sk: entry.id, ...entry, retrieved_at: retrievedAt } },
    }));
    const putChunks = Array.from({ length: Math.ceil(writes.length / 25) }, (_, index) => writes.slice(index * 25, (index + 1) * 25));
    for (let index = 0; index < putChunks.length; index += 4) {
      await Promise.all(putChunks.slice(index, index + 4).map((chunk) =>
        batchWriteWithRetry(this.client, this.tableName, chunk),
      ));
    }
    const retained = new Set(uniqueEntries.map((entry) => entry.id));
    let cursor: Record<string, unknown> | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :source',
        ExpressionAttributeValues: { ':source': source },
        ProjectionExpression: 'pk, sk',
        ExclusiveStartKey: cursor,
        Limit: 1000,
      }));
      const stale = (result.Items ?? []).flatMap((item) =>
        typeof item.sk === 'string' && item.sk !== '__refresh_status__' && !retained.has(item.sk)
          ? [{ DeleteRequest: { Key: { pk: source, sk: item.sk } } }]
          : [],
      );
      for (let index = 0; index < stale.length; index += 25) {
        await batchWriteWithRetry(this.client, this.tableName, stale.slice(index, index + 25));
      }
      cursor = result.LastEvaluatedKey;
      if (!cursor) break;
    }
    if (cursor) throw new Error('Catalog cleanup exceeded its bounded page limit.');
  }

  async listSource(source: string, limit: number): Promise<CatalogEntry[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :source',
      ExpressionAttributeValues: { ':source': source },
      Limit: Math.min(Math.max(limit, 1), 1000),
    }));
    return (result.Items ?? []).flatMap((item) => typeof item.id === 'string' && typeof item.title === 'string'
      ? [{ id: item.id, title: item.title, desc: typeof item.desc === 'string' ? item.desc : '',
          ...(typeof item.sector === 'string' ? { sector: item.sector } : {}),
          ...(typeof item.org === 'string' ? { org: item.org } : {}),
          ...(typeof item.geography === 'string' ? { geography: item.geography } : {}) }]
      : []);
  }

  async putRefreshStatus(source: string, status: RefreshSourceStatus): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: source, sk: '__refresh_status__', ...status },
    }));
  }

  async getRefreshStatus(source: string): Promise<RefreshSourceStatus | null> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: source, sk: '__refresh_status__' },
    }));
    const item = result.Item;
    if (!item || !['success', 'partial', 'failed'].includes(String(item.status))) return null;
    return {
      status: item.status as RefreshSourceStatus['status'],
      records: Number(item.records ?? 0),
      timestamp: String(item.timestamp ?? ''),
      ...(typeof item.warning === 'string' ? { warning: item.warning } : {}),
    };
  }
}
