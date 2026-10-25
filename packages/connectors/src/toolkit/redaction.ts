const SENSITIVE_QUERY_PARAMS = new Set([
  'api-key',
  'apikey',
  'api_key',
  'token',
  'access_token',
  'secret',
  'key',
  'auth',
  'signature',
  'sig',
  'x-amz-signature',
  'x-amz-security-token',
  'x-amz-credential',
  'awsaccesskeyid',
]);

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'proxy-authorization',
]);

export function redactUrl(urlInput: string | URL): string {
  try {
    const url =
      typeof urlInput === 'string' ? new URL(urlInput) : new URL(urlInput.href);
    for (const [key] of url.searchParams.entries()) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    // If URL parsing fails, perform regex masking on common query param formats
    return urlInput
      .toString()
      .replace(
        /([?&](?:api[_-]?key|token|secret|signature|sig)=)[^&]+/gi,
        '$1[REDACTED]',
      );
  }
}

export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function redactErrorMessage(message: string): string {
  // Replace sensitive tokens, credentials, and query params in error strings
  return message
    .replace(
      /([?&](?:api[_-]?key|token|secret|signature|sig)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
}
