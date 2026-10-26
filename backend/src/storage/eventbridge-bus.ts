import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';

export interface EventBridgePublisherOptions {
  eventBusName?: string;
  region?: string;
  client?: EventBridgeClient;
}

export class EventBridgeBus {
  private readonly client: EventBridgeClient | null;
  private readonly eventBusName: string;
  private readonly publishedEvents: Array<{
    detailType: string;
    detail: Record<string, unknown>;
    timestamp: string;
  }> = [];

  constructor(options: EventBridgePublisherOptions = {}) {
    this.eventBusName = options.eventBusName ?? process.env.EVENT_BUS_NAME ?? 'default';
    const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';

    if (options.client) {
      this.client = options.client;
    } else {
      try {
        this.client = new EventBridgeClient({ region });
      } catch {
        this.client = null;
      }
    }
  }

  /**
   * Publishes domain event to EventBridge.
   */
  async publishDomainEvent(
    detailType: string,
    detail: Record<string, unknown>,
    source = 'datascout.platform',
  ): Promise<boolean> {
    const timestamp = new Date().toISOString();
    const entry = {
      EventBusName: this.eventBusName,
      Source: source,
      DetailType: detailType,
      Detail: JSON.stringify({ ...detail, emittedAt: timestamp }),
      Time: new Date(),
    };

    this.publishedEvents.push({ detailType, detail, timestamp });

    if (!this.client || process.env.NODE_ENV === 'test') {
      return true;
    }

    try {
      await this.client.send(
        new PutEventsCommand({
          Entries: [entry],
        }),
      );
      return true;
    } catch {
      // EventBridge publish errors should not break application flow
      return false;
    }
  }

  getRecentEvents() {
    return [...this.publishedEvents];
  }
}

let cachedBus: EventBridgeBus | null = null;

export function getEventBridgeBus(): EventBridgeBus {
  if (!cachedBus) {
    cachedBus = new EventBridgeBus();
  }
  return cachedBus;
}
