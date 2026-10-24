import type { SpanHandle, Tracer } from '../ports.js';

export interface RecordedScore {
  name: string;
  value: number | boolean;
  comment?: string;
}

export interface RecordedSpan {
  name: string;
  kind: 'span' | 'generation';
  attributes: Record<string, string | number | boolean>;
  scores: RecordedScore[];
}

export class NoopTracer implements Tracer {
  async withSpan<T>(
    _name: string,
    _opts: { kind: 'span' | 'generation' },
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    return fn({
      setAttributes: () => undefined,
      score: () => undefined,
    });
  }

  async flush(timeoutMs: number): Promise<void> {
    void timeoutMs;
  }
}

export class InMemoryTracer implements Tracer {
  private readonly recordedSpans: RecordedSpan[] = [];

  get spans(): readonly RecordedSpan[] {
    return structuredClone(this.recordedSpans);
  }

  async withSpan<T>(
    name: string,
    opts: { kind: 'span' | 'generation' },
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    const record: RecordedSpan = {
      name,
      kind: opts.kind,
      attributes: {},
      scores: [],
    };
    const handle: SpanHandle = {
      setAttributes: (attrs) => {
        Object.assign(record.attributes, attrs);
      },
      score: (scoreName, value, comment) => {
        record.scores.push(
          comment === undefined
            ? { name: scoreName, value }
            : { name: scoreName, value, comment },
        );
      },
    };

    try {
      return await fn(handle);
    } finally {
      this.recordedSpans.push(structuredClone(record));
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    void timeoutMs;
  }
}
