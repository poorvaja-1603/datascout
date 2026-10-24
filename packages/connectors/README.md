# `@datascout/connectors`

This package implements the connector toolkit and dataset source adapters for the DataScout MVP.

## Toolkit Overview

The connector toolkit provides secure, resilient network primitives shared across all catalog adapters:

* **SSRF Guard (`src/toolkit/ssrf.ts`)**:
  * Enforces HTTPS protocol for all outbound requests.
  * Blocks private, link-local, loopback, broadcast, and multicast IPv4 / IPv6 addresses.
  * Blocks the AWS instance metadata service (`169.254.169.254`).
  * Resolves hostnames via DNS and verifies all resolved IP addresses before connecting.
  * Validates hostnames against an allowlist where configured.

* **Safe Fetch (`src/toolkit/safe-fetch.ts`)**:
  * Wraps `fetch` with SSRF validation.
  * Disables automatic redirects (`redirect: 'manual'`) and validates redirect target URLs against the SSRF guard before following.
  * Enforces configurable response payload limits (`maxBytes`, default 5MB).
  * Enforces request timeouts with abort signals.
  * Enforces content-type allowlists.
  * Formats errors with redacted URLs and safe messages.

* **Secret Redaction (`src/toolkit/redaction.ts`)**:
  * Strips sensitive query-string parameters (`api-key`, `token`, `secret`, `sig`, `AWSAccessKeyId`) from URLs before logging or returning error objects.
  * Redacts `Authorization` and `x-api-key` headers.
  * Redacts sensitive strings in error messages.

* **Retry & Backoff (`src/toolkit/retry.ts`)**:
  * Implements exponential backoff with jitter for transient errors (429, 500, 502, 503, 504, connection reset).
  * Respects HTTP 429 `Retry-After` header (seconds or HTTP-date).
  * Non-transient client errors (400, 401, 403, 404, 422) fail immediately without retry.

* **Fixture Recorder (`src/toolkit/recorder.ts`)**:
  * Records sanitized upstream HTTP responses to disk for deterministic unit tests.

## Running Tests

```bash
npm test --workspace=@datascout/connectors
```
