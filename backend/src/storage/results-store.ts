import {
  type SearchResponse,
  SearchResponseSchema,
  DataScoutError,
} from '@datascout/contracts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

export interface StoredResult {
  requestId: string;
  ownerSub: string;
  searchResponse: SearchResponse;
  ttl: number;
}

export interface ResultsStore {
  putResult(
    requestId: string,
    ownerSub: string,
    searchResponse: SearchResponse,
    ttlSeconds?: number,
  ): Promise<void>;
  getResult(requestId: string): Promise<StoredResult | null>;
}

export const DEFAULT_RESULTS_TTL_SECONDS = 86_400; // 24 hours

export class InMemoryResultsStore implements ResultsStore {
  private readonly items = new Map<string, StoredResult>();

  async putResult(
    requestId: string,
    ownerSub: string,
    searchResponse: SearchResponse,
    ttlSeconds: number = DEFAULT_RESULTS_TTL_SECONDS,
  ): Promise<void> {
    if (this.items.has(requestId)) {
      throw new DataScoutError(
        'internal_error',
        'Result with this request_id already exists.',
        false,
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = nowSeconds + Math.floor(ttlSeconds);

    this.items.set(requestId, {
      requestId,
      ownerSub,
      searchResponse,
      ttl,
    });
  }

  async getResult(requestId: string): Promise<StoredResult | null> {
    const item = this.items.get(requestId);
    if (!item) {
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (item.ttl <= nowSeconds) {
      return null;
    }

    const validatedResponse = SearchResponseSchema.parse(item.searchResponse);
    return {
      ...item,
      searchResponse: validatedResponse,
    };
  }

  clear(): void {
    this.items.clear();
  }
}

export class DynamoDbResultsStore implements ResultsStore {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName?: string, client?: DynamoDBClient) {
    this.tableName =
      tableName || process.env.RESULTS_TABLE_NAME || 'datascout-results-dev';
    const baseClient = client || new DynamoDBClient({});
    this.docClient = DynamoDBDocumentClient.from(baseClient, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });
  }

  async putResult(
    requestId: string,
    ownerSub: string,
    searchResponse: SearchResponse,
    ttlSeconds: number = DEFAULT_RESULTS_TTL_SECONDS,
  ): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = nowSeconds + Math.floor(ttlSeconds);

    try {
      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: requestId,
            owner_sub: ownerSub,
            search_response: JSON.stringify(searchResponse),
            ttl,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (err: unknown) {
      const errorName = (err as { name?: string })?.name;
      if (errorName === 'ConditionalCheckFailedException') {
        throw new DataScoutError(
          'internal_error',
          'Result with this request_id already exists.',
          false,
        );
      }
      throw new DataScoutError(
        'internal_error',
        'Failed to store search result.',
        false,
      );
    }
  }

  async getResult(requestId: string): Promise<StoredResult | null> {
    let result;
    try {
      result = await this.docClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk: requestId },
        }),
      );
    } catch {
      throw new DataScoutError(
        'internal_error',
        'Failed to query search result storage.',
        false,
      );
    }

    const item = result.Item;
    if (!item) {
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = typeof item.ttl === 'number' ? item.ttl : 0;
    if (ttl <= nowSeconds) {
      return null;
    }

    try {
      const rawResponse =
        typeof item.search_response === 'string'
          ? JSON.parse(item.search_response)
          : item.search_response;
      const validatedResponse = SearchResponseSchema.parse(rawResponse);

      return {
        requestId,
        ownerSub: String(item.owner_sub || ''),
        searchResponse: validatedResponse,
        ttl,
      };
    } catch {
      return null;
    }
  }
}
