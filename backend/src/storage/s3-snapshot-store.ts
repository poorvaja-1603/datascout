import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export interface S3SnapshotStoreOptions {
  bucketName?: string;
  region?: string;
  client?: S3Client;
}

export class S3SnapshotStore {
  private readonly client: S3Client | null;
  private readonly bucketName: string | null;
  private readonly memoryStore = new Map<string, string>();

  constructor(options: S3SnapshotStoreOptions = {}) {
    this.bucketName =
      options.bucketName ?? process.env.SNAPSHOTS_BUCKET_NAME ?? null;
    const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';

    if (options.client) {
      this.client = options.client;
    } else if (this.bucketName) {
      try {
        this.client = new S3Client({ region });
      } catch {
        this.client = null;
      }
    } else {
      this.client = null;
    }
  }

  /**
   * Saves a raw dataset snapshot to Amazon S3.
   * Path pattern: snapshots/{source}/{dataset_slug}/snapshot.json
   */
  async saveDatasetSnapshot(
    datasetId: string,
    snapshotData: unknown,
  ): Promise<string | null> {
    const sanitizedId = datasetId.replace(':', '/').replace(/[^a-zA-Z0-9_\-\/]/g, '_');
    const key = `snapshots/${sanitizedId}/snapshot.json`;
    return this.putObject(key, snapshotData, {
      dataset_id: datasetId,
      artifact_type: 'dataset_snapshot',
    });
  }

  /**
   * Saves a periodic catalog harvest snapshot to Amazon S3.
   * Path pattern: catalog-harvests/{source}/{isoDate}.json
   */
  async saveCatalogHarvest(
    source: string,
    harvestData: unknown,
  ): Promise<string | null> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `catalog-harvests/${source}/${timestamp}.json`;
    return this.putObject(key, harvestData, {
      source,
      artifact_type: 'catalog_harvest',
    });
  }

  /**
   * Writes JSON payload to S3 or memory fallback.
   */
  async putObject(
    key: string,
    data: unknown,
    metadata?: Record<string, string>,
  ): Promise<string | null> {
    const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

    if (!this.bucketName || !this.client) {
      this.memoryStore.set(key, body);
      return key;
    }

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          ServerSideEncryption: 'AES256',
          Metadata: metadata,
        }),
      );
      return key;
    } catch {
      // S3 errors should not block search or harvest pipelines
      this.memoryStore.set(key, body);
      return key;
    }
  }

  /**
   * Reads raw snapshot from S3 or memory store.
   */
  async getObject(key: string): Promise<string | null> {
    if (this.memoryStore.has(key)) {
      return this.memoryStore.get(key) ?? null;
    }

    if (!this.bucketName || !this.client) return null;

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      );
      if (!response.Body) return null;
      return await response.Body.transformToString();
    } catch {
      return null;
    }
  }
}

let cachedSnapshotStore: S3SnapshotStore | null = null;

export function getS3SnapshotStore(): S3SnapshotStore {
  if (!cachedSnapshotStore) {
    cachedSnapshotStore = new S3SnapshotStore();
  }
  return cachedSnapshotStore;
}
