import {
  type DatasetDetail,
  type CompareDataset,
  type ScoreBreakdown,
  CompareDatasetSchema,
  DatasetDetailSchema,
  DataScoutError,
} from '@datascout/contracts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';

export interface DatasetsStore {
  getDataset(datasetId: string): Promise<DatasetDetail | null>;
  putDataset(dataset: DatasetDetail, score?: number, score_breakdown?: ScoreBreakdown): Promise<void>;
  batchGetDatasets(datasetIds: string[]): Promise<DatasetDetail[]>;
  batchGetComparisons(datasetIds: string[]): Promise<CompareDataset[]>;
}

export class InMemoryDatasetsStore implements DatasetsStore {
  private readonly items = new Map<string, { detail: DatasetDetail; score?: number | undefined; score_breakdown?: ScoreBreakdown | undefined }>();

  async getDataset(datasetId: string): Promise<DatasetDetail | null> {
    const item = this.items.get(datasetId)?.detail;
    if (!item) {
      return null;
    }
    return DatasetDetailSchema.parse(item);
  }

  async putDataset(dataset: DatasetDetail, score?: number, score_breakdown?: ScoreBreakdown): Promise<void> {
    const validated = DatasetDetailSchema.parse(dataset);
    this.items.set(validated.dataset.dataset_id, { detail: validated, score, score_breakdown });
  }

  async batchGetDatasets(datasetIds: string[]): Promise<DatasetDetail[]> {
    const results: DatasetDetail[] = [];
    for (const id of datasetIds) {
      const item = this.items.get(id)?.detail;
      if (item) {
        results.push(DatasetDetailSchema.parse(item));
      }
    }
    return results;
  }

  async batchGetComparisons(datasetIds: string[]): Promise<CompareDataset[]> {
    return datasetIds.flatMap((id) => {
      const item = this.items.get(id);
      if (!item || item.score === undefined || !item.score_breakdown) return [];
      const { dataset, evidence, matches } = item.detail;
      return [CompareDatasetSchema.parse({ dataset, evidence, matches, score: item.score, score_breakdown: item.score_breakdown })];
    });
  }

  clear(): void {
    this.items.clear();
  }
}

export class DynamoDbDatasetsStore implements DatasetsStore {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName?: string, client?: DynamoDBClient) {
    this.tableName =
      tableName || process.env.DATASETS_TABLE_NAME || 'datascout-datasets-dev';
    const baseClient = client || new DynamoDBClient({});
    this.docClient = DynamoDBDocumentClient.from(baseClient, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });
  }

  async getDataset(datasetId: string): Promise<DatasetDetail | null> {
    try {
      const result = await this.docClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { dataset_id: datasetId },
        }),
      );

      const item = result.Item;
      if (!item) {
        return null;
      }

      const rawDetail =
        typeof item.detail === 'string' ? JSON.parse(item.detail) : item.detail;
      return DatasetDetailSchema.parse(rawDetail);
    } catch {
      throw new DataScoutError(
        'internal_error',
        'Failed to query dataset storage.',
        false,
      );
    }
  }

  async putDataset(dataset: DatasetDetail, score?: number, score_breakdown?: ScoreBreakdown): Promise<void> {
    const validated = DatasetDetailSchema.parse(dataset);
    try {
      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            dataset_id: validated.dataset.dataset_id,
            detail: JSON.stringify(validated),
            ...(score !== undefined ? { score } : {}),
            ...(score_breakdown ? { score_breakdown: JSON.stringify(score_breakdown) } : {}),
          },
        }),
      );
    } catch {
      throw new DataScoutError(
        'internal_error',
        'Failed to store dataset record.',
        false,
      );
    }
  }

  async batchGetDatasets(datasetIds: string[]): Promise<DatasetDetail[]> {
    if (datasetIds.length === 0) {
      return [];
    }

    const uniqueIds = [...new Set(datasetIds)];
    const chunkSize = 25; // DynamoDB BatchGetItem max is 100 items; 25 is safe chunk size
    const results: DatasetDetail[] = [];

    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);
      const keys = chunk.map((id) => ({ dataset_id: id }));

      try {
        const response = await this.docClient.send(
          new BatchGetCommand({
            RequestItems: {
              [this.tableName]: {
                Keys: keys,
              },
            },
          }),
        );

        const items = response.Responses?.[this.tableName] || [];
        for (const item of items) {
          const rawDetail =
            typeof item.detail === 'string'
              ? JSON.parse(item.detail)
              : item.detail;
          results.push(DatasetDetailSchema.parse(rawDetail));
        }
      } catch {
        throw new DataScoutError(
          'internal_error',
          'Failed to batch get dataset records.',
          false,
        );
      }
    }

    return results;
  }

  async batchGetComparisons(datasetIds: string[]): Promise<CompareDataset[]> {
    if (datasetIds.length === 0) return [];
    const uniqueIds = [...new Set(datasetIds)];
    const results = new Map<string, CompareDataset>();
    for (let i = 0; i < uniqueIds.length; i += 25) {
      const chunk = uniqueIds.slice(i, i + 25);
      try {
        const response = await this.docClient.send(new BatchGetCommand({
          RequestItems: { [this.tableName]: { Keys: chunk.map((id) => ({ dataset_id: id })) } },
        }));
        for (const item of response.Responses?.[this.tableName] ?? []) {
          if (typeof item.score !== 'number' || !item.score_breakdown) continue;
          const detail = DatasetDetailSchema.parse(typeof item.detail === 'string' ? JSON.parse(item.detail) : item.detail);
          const breakdown = typeof item.score_breakdown === 'string' ? JSON.parse(item.score_breakdown) : item.score_breakdown;
          results.set(detail.dataset.dataset_id, CompareDatasetSchema.parse({
            dataset: detail.dataset, evidence: detail.evidence, matches: detail.matches,
            score: item.score, score_breakdown: breakdown,
          }));
        }
      } catch {
        throw new DataScoutError('internal_error', 'Failed to batch get comparison records.', false);
      }
    }
    return datasetIds.flatMap((id) => results.has(id) ? [results.get(id)!] : []);
  }
}
