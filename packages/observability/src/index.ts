import { LangfuseClient } from '@langfuse/client';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  startActiveObservation,
  type LangfuseGeneration,
  type LangfuseSpan,
} from '@langfuse/tracing';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { NoopTracer, type SpanHandle, type Tracer } from '@datascout/contracts';

const SENSITIVE_KEY_PATTERN =
  /(?:access.?key|api.?key|authorization|cookie|credential|e-?mail|host|owner|password|process|prompt|query|secret|token|user.?id|user.?input)/i;
const SENSITIVE_VALUE_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:pk|sk)-lf-[A-Za-z0-9_-]+\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:aws_secret_access_key|secret_access_key)\s*[:=]\s*[A-Za-z0-9/+=]+\b/gi,
];

export type LangfuseEnvironment = Readonly<Record<string, string | undefined>>;

export interface LangfuseTracerOptions {
  environment?: LangfuseEnvironment;
  warn?: (message: string) => void;
}

interface RuntimeConfiguration {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  release?: string;
}

interface LangfuseRuntime {
  configuration: RuntimeConfiguration;
  processor: LangfuseSpanProcessor;
  sdk: NodeSDK;
  client: LangfuseClient;
}

let runtime: LangfuseRuntime | undefined;

export function redactSensitiveText(value: string): string {
  return SENSITIVE_VALUE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, '[REDACTED]'),
    value,
  );
}

export function redactTelemetryValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactTelemetryValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        SENSITIVE_KEY_PATTERN.test(key)
          ? []
          : [[key, redactTelemetryValue(item)]],
      ),
    );
  }
  return value;
}

function sanitizeAttributes(
  attrs: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attrs).flatMap(([key, value]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) return [];
      return [
        [key, typeof value === 'string' ? redactSensitiveText(value) : value],
      ];
    }),
  );
}

function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

function getConfiguration(
  environment: LangfuseEnvironment,
): RuntimeConfiguration | undefined {
  const publicKey = environment['LANGFUSE_PUBLIC_KEY']?.trim();
  const secretKey = environment['LANGFUSE_SECRET_KEY']?.trim();
  const baseUrl = environment['LANGFUSE_BASE_URL']?.trim();

  if (!publicKey && !secretKey && !baseUrl) return undefined;
  if (
    !publicKey?.startsWith('pk-lf-') ||
    publicKey.length <= 'pk-lf-'.length ||
    !secretKey?.startsWith('sk-lf-') ||
    secretKey.length <= 'sk-lf-'.length ||
    !baseUrl ||
    !isValidBaseUrl(baseUrl)
  ) {
    throw new Error('Langfuse credentials or base URL are invalid.');
  }

  const tracingEnvironment = environment['LANGFUSE_TRACING_ENVIRONMENT'];
  const release = environment['LANGFUSE_RELEASE'];
  return {
    publicKey,
    secretKey,
    baseUrl,
    ...(tracingEnvironment
      ? { environment: redactSensitiveText(tracingEnvironment) }
      : {}),
    ...(release ? { release: redactSensitiveText(release) } : {}),
  };
}

function sameConfiguration(
  left: RuntimeConfiguration,
  right: RuntimeConfiguration,
): boolean {
  return (
    left.publicKey === right.publicKey &&
    left.secretKey === right.secretKey &&
    left.baseUrl === right.baseUrl &&
    left.environment === right.environment &&
    left.release === right.release
  );
}

function createHandle(
  observation: LangfuseSpan | LangfuseGeneration,
  client: LangfuseClient,
  warn: (message: string) => void,
): SpanHandle {
  return {
    setAttributes(attrs) {
      try {
        observation.update({ metadata: sanitizeAttributes(attrs) });
      } catch {
        warn('Langfuse span attributes could not be recorded.');
      }
    },
    score(name, value, comment) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) {
        warn('Langfuse score name was rejected.');
        return;
      }
      try {
        client.score.observation(
          { otelSpan: observation.otelSpan },
          {
            name,
            value: typeof value === 'boolean' ? Number(value) : value,
            dataType: typeof value === 'boolean' ? 'BOOLEAN' : 'NUMERIC',
            ...(comment ? { comment: redactSensitiveText(comment) } : {}),
          },
        );
      } catch {
        warn('Langfuse score could not be recorded.');
      }
    },
  };
}

export class LangfuseTracer implements Tracer {
  constructor(
    private readonly activeRuntime: LangfuseRuntime,
    private readonly warn: (message: string) => void = console.warn,
  ) {}

  async withSpan<T>(
    name: string,
    opts: { kind: 'span' | 'generation' },
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    let callbackStarted = false;
    try {
      const run = async (observation: LangfuseSpan | LangfuseGeneration) => {
        callbackStarted = true;
        return fn(
          createHandle(observation, this.activeRuntime.client, this.warn),
        );
      };
      const safeName = redactSensitiveText(name);
      if (opts.kind === 'generation') {
        return await startActiveObservation(safeName, run, {
          asType: 'generation',
        });
      }
      return await startActiveObservation(safeName, run, { asType: 'span' });
    } catch (error) {
      if (callbackStarted) throw error;
      this.warn('Langfuse tracing is unavailable; running without a span.');
      return fn(createNoopHandle());
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      this.warn('Langfuse flush skipped because its timeout is invalid.');
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const flush = Promise.all([
        this.activeRuntime.processor.forceFlush(),
        this.activeRuntime.client.flush(),
      ]);
      await Promise.race([
        flush,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Langfuse flush timed out.')),
            timeoutMs,
          );
        }),
      ]);
    } catch {
      this.warn('Langfuse telemetry could not be flushed before the deadline.');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function createNoopHandle(): SpanHandle {
  return {
    setAttributes() {},
    score() {},
  };
}

export function createLangfuseTracer(
  options: LangfuseTracerOptions = {},
): Tracer {
  const environment = options.environment ?? process.env;
  const warn = options.warn ?? console.warn;

  let configuration: RuntimeConfiguration | undefined;
  try {
    configuration = getConfiguration(environment);
  } catch {
    warn('Langfuse configuration is invalid; tracing is disabled.');
    return new NoopTracer();
  }
  if (!configuration) return new NoopTracer();

  if (runtime) {
    if (sameConfiguration(runtime.configuration, configuration)) {
      return new LangfuseTracer(runtime, warn);
    }
    warn('Langfuse is already initialized with a different configuration.');
    return new NoopTracer();
  }

  try {
    const processor = new LangfuseSpanProcessor({
      publicKey: configuration.publicKey,
      secretKey: configuration.secretKey,
      baseUrl: configuration.baseUrl,
      ...(configuration.environment
        ? { environment: configuration.environment }
        : {}),
      ...(configuration.release ? { release: configuration.release } : {}),
      mask: ({ data }) => redactTelemetryValue(data),
      mediaUploadEnabled: false,
    });
    const sdk = new NodeSDK({
      autoDetectResources: false,
      serviceName: 'datascout',
      spanProcessors: [processor],
    });
    sdk.start();
    const client = new LangfuseClient({
      publicKey: configuration.publicKey,
      secretKey: configuration.secretKey,
      baseUrl: configuration.baseUrl,
    });
    runtime = { configuration, processor, sdk, client };
    return new LangfuseTracer(runtime, warn);
  } catch {
    warn('Langfuse could not be initialized; tracing is disabled.');
    return new NoopTracer();
  }
}

export async function shutdownLangfuse(
  timeoutMs = 5_000,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  if (!runtime) return;
  const activeRuntime = runtime;
  runtime = undefined;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([
        activeRuntime.processor.forceFlush(),
        activeRuntime.client.flush(),
      ]).then(() => activeRuntime.sdk.shutdown()),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Langfuse shutdown timed out.')),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    warn('Langfuse telemetry could not be shut down cleanly.');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
