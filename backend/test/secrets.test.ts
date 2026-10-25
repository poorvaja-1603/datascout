import { describe, expect, it, vi } from 'vitest';
import { createRuntimeSecretLoader } from '../src/secrets.js';

describe('runtime secret loader', () => {
  it('uses the local environment value when no secret ARN is configured', async () => {
    const readSecret = vi.fn(async () => 'unused');
    const load = createRuntimeSecretLoader(readSecret, {
      DATAGOVIN_API_KEY: 'local-data-key',
    });

    await expect(load('DATAGOVIN_API_KEY_SECRET_ARN', 'DATAGOVIN_API_KEY'))
      .resolves.toBe('local-data-key');
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('reads and caches a secret by ARN without logging its value', async () => {
    const readSecret = vi.fn(async () => 'hf_token_sensitive_value');
    const load = createRuntimeSecretLoader(readSecret, {
      HUGGINGFACE_API_TOKEN_SECRET_ARN: 'arn:aws:secretsmanager:ap-south-1:123456789012:secret:datascout/hf',
      HUGGINGFACE_API_TOKEN: 'should-not-be-used',
    });

    await expect(load('HUGGINGFACE_API_TOKEN_SECRET_ARN', 'HUGGINGFACE_API_TOKEN'))
      .resolves.toBe('hf_token_sensitive_value');
    await expect(load('HUGGINGFACE_API_TOKEN_SECRET_ARN', 'HUGGINGFACE_API_TOKEN'))
      .resolves.toBe('hf_token_sensitive_value');
    expect(readSecret).toHaveBeenCalledTimes(1);
  });

  it('rejects empty configured secrets without exposing their identifiers or contents', async () => {
    const load = createRuntimeSecretLoader(async () => '  ', {
      DATAGOVIN_API_KEY_SECRET_ARN: 'secret-arn-private',
    });

    await expect(load('DATAGOVIN_API_KEY_SECRET_ARN', 'DATAGOVIN_API_KEY'))
      .rejects.toThrow('Configured upstream credential could not be loaded.');
  });

  it('replaces SDK error details instead of allowing secret data into logs', async () => {
    const load = createRuntimeSecretLoader(async () => {
      throw new Error('request failed with hf_token_sensitive_value');
    }, {
      HUGGINGFACE_API_TOKEN_SECRET_ARN: 'secret-arn-private',
    });

    await expect(load('HUGGINGFACE_API_TOKEN_SECRET_ARN', 'HUGGINGFACE_API_TOKEN'))
      .rejects.toThrow('Configured upstream credential could not be loaded.');
    await expect(load('HUGGINGFACE_API_TOKEN_SECRET_ARN', 'HUGGINGFACE_API_TOKEN'))
      .rejects.not.toThrow('hf_token_sensitive_value');
  });
});
