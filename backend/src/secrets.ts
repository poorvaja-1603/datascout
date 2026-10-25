import { Buffer } from 'node:buffer';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

type SecretFetcher = (secretArn: string) => Promise<string | undefined>;

const secretsClient = new SecretsManagerClient({ maxAttempts: 2 });
const cache = new Map<string, { value: string; expiresAt: number }>();
const inFlight = new Map<string, Promise<string>>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchSecret(secretArn: string): Promise<string | undefined> {
  try {
    const result = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (typeof result.SecretString === 'string') return result.SecretString;
    if (result.SecretBinary)
      return Buffer.from(result.SecretBinary).toString('utf8');
    return undefined;
  } catch {
    // Never include SDK errors, secret identifiers, or secret values in logs.
    throw new Error('Configured upstream credential could not be loaded.');
  }
}

export function createRuntimeSecretLoader(
  readSecret: SecretFetcher = fetchSecret,
  environment: Record<string, string | undefined> = process.env,
): (
  arnVariable: string,
  localValueVariable: string,
) => Promise<string | undefined> {
  return async (arnVariable, localValueVariable) => {
    const secretArn = environment[arnVariable]?.trim();
    if (!secretArn) {
      const localValue = environment[localValueVariable]?.trim();
      return localValue || undefined;
    }

    const cached = cache.get(secretArn);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = inFlight.get(secretArn);
    if (pending) return pending;

    const load = readSecret(secretArn)
      .then((value) => {
        const secret = value?.trim();
        if (!secret)
          throw new Error('Configured upstream credential is empty.');
        cache.set(secretArn, {
          value: secret,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return secret;
      })
      .catch(() => {
        throw new Error('Configured upstream credential could not be loaded.');
      })
      .finally(() => inFlight.delete(secretArn));
    inFlight.set(secretArn, load);
    return load;
  };
}

export const loadRuntimeSecret = createRuntimeSecretLoader();
