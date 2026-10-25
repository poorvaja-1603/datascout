import { describe, expect, it, vi } from 'vitest';
import {
  createLangfuseTracer,
  LangfuseTracer,
  redactSensitiveText,
  redactTelemetryValue,
  shutdownLangfuse,
} from '../src/index.js';

describe('Langfuse observability', () => {
  it('redacts credentials and email addresses from sensitive text', () => {
    expect(
      redactSensitiveText(
        'Contact user@example.com with Bearer abc.def and sk-lf-secret.',
      ),
    ).toBe('Contact [REDACTED] with [REDACTED] and [REDACTED].');
    expect(redactSensitiveText('AKIA1234567890ABCDEF')).toBe('[REDACTED]');
    expect(
      redactSensitiveText(
        'Call +91 9876543210; Aadhaar 1234 5678 9012; PAN ABCDE1234F',
      ),
    ).toBe('Call [REDACTED]; Aadhaar [REDACTED]; PAN [REDACTED]');
    expect(
      redactSensitiveText('https://example.test/?api_key=private&ok=yes'),
    ).toBe('https://example.test/?api_key=[REDACTED]&ok=yes');
    expect(redactSensitiveText('JWT eyJhbGci.eyJzdWI.abc123')).toBe(
      'JWT [REDACTED]',
    );
    expect(
      redactTelemetryValue({
        attributes: {
          email: 'user@example.com',
          apiKey: 'do-not-keep',
          region: 'us-east-1',
        },
        resourceAttributes: {
          'process.owner': 'local-user',
          'process.command_args': ['node', '--env-file=evals/.env'],
          'host.id': 'local-host-id',
          'service.name': 'datascout',
        },
        prompt: 'Never export this content.',
      }),
    ).toEqual({
      attributes: { region: 'us-east-1' },
      resourceAttributes: { 'service.name': 'datascout' },
    });
  });

  it('disables telemetry when configuration is missing or invalid', async () => {
    const warn = vi.fn();
    const missing = createLangfuseTracer({
      environment: {},
      warn,
    });
    const invalid = createLangfuseTracer({
      environment: {
        LANGFUSE_PUBLIC_KEY: 'pk-lf-',
        LANGFUSE_SECRET_KEY: 'sk-lf-',
        LANGFUSE_BASE_URL: 'not a url',
      },
      warn,
    });

    await expect(
      missing.withSpan('missing-config', { kind: 'span' }, async () => 'ok'),
    ).resolves.toBe('ok');
    await expect(
      invalid.withSpan('invalid-config', { kind: 'span' }, async () => 'ok'),
    ).resolves.toBe('ok');
    await expect(missing.flush(100)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Langfuse configuration is invalid; tracing is disabled.',
    );
  });

  it('keeps application callback failures visible instead of masking them as telemetry failures', async () => {
    const tracer = createLangfuseTracer({ environment: {} });
    const failure = new Error('application failure');
    await expect(
      tracer.withSpan('business-operation', { kind: 'span' }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('reuses matching initialized configuration and rejects reconfiguration', async () => {
    const environment = {
      LANGFUSE_PUBLIC_KEY: 'pk-lf-public-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-secret-test',
      LANGFUSE_BASE_URL: 'https://localhost.invalid',
    };
    const warn = vi.fn();
    const tracer = createLangfuseTracer({ environment, warn });
    expect(tracer).toBeInstanceOf(LangfuseTracer);
    expect(createLangfuseTracer({ environment, warn })).toBeInstanceOf(
      LangfuseTracer,
    );

    const changed = createLangfuseTracer({
      environment: {
        ...environment,
        LANGFUSE_BASE_URL: 'https://other.invalid',
      },
      warn,
    });
    await expect(
      changed.withSpan('changed-config', { kind: 'span' }, async () => 'ok'),
    ).resolves.toBe('ok');
    expect(warn).toHaveBeenCalledWith(
      'Langfuse is already initialized with a different configuration.',
    );
    await shutdownLangfuse(100, warn);
  });
});
