# Source Note: data.gov.in (Open Government Data Platform India)

## Integration Overview
* **Candidate Discovery**: The portal lacks an open full-text search API that can be queried dynamically for user queries. Instead, the catalog list endpoint (`https://api.data.gov.in/catalogs`) is harvested into an indexed catalog cache (DynamoDB/S3 or in-memory) by a scheduled refresh task, allowing local search over harvested dataset titles, descriptions, sectors, and organizations.
* **Resource Details and Samples**: The resource API endpoint (`https://api.data.gov.in/resource/:id`) retrieves schema fields and row records with offset-based paging.
* **Format**: Primarily JSON and CSV.

## Harvest Strategy
1. **Bounded Paging**: Pages through `/catalogs?format=json&offset=...&limit=...` with a configurable page size (default 100, max 1000).
2. **Safety Caps**:
   * Hard limits on maximum total records (default 1,000) and maximum pages (default 50).
   * Global byte budget enforcement across all harvest requests (default 10MB).
   * Emits explicit warnings when safety caps are reached.
3. **Rate Limiting**:
   * Introduces a polite delay between pages (default 100ms) to prevent overwhelming upstream servers.
   * Respects HTTP 429 and upstream `Retry-After` headers via the `withRetry` and `safeFetch` toolkits.
4. **Native ID Validation**:
   * Validates all native catalog IDs against a strict pattern (`/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/`) to block path traversal, query-string injection, and malformed identifiers.
   * Invalid IDs are skipped and tracked in the harvest skip count.

## API Key Setup and Secrets Handling
1. **Credential Requirement**:
   * The catalog list endpoint is accessible without an API key, but resource row sampling requires a registered OGD API key.
   * Provided via `DATAGOVIN_API_KEY` environment variable or injected through connector options.
   * A missing API key does not disable local search over the harvested public catalog. It only blocks resource detail and row-sample requests; sample verification is then reported as unavailable.
2. **Query String Redaction**:
   * The API key must be transmitted in the query string (`?api-key=...`).
   * Every URL, log line, error message, and exception thrown by the connector passes through the redaction helper (`redactUrl`, `redactErrorMessage`).
   * Tests actively assert that canary keys never appear in error messages or logs.

## Known Quirks and Workarounds
1. **CSV-on-JSON Quirk**:
   * Certain resources return raw RFC 4180 CSV text even when `format=json` is explicitly requested in the query parameters.
   * The connector inspects response bytes and uses the B5 content detector (`sniffFormat`) to identify CSV payloads, gracefully parsing them via the bounded RFC 4180 CSV parser rather than throwing a JSON parse error.
2. **Case-Sensitive Filter Field Names**:
   * Resource filter parameter names (e.g. `filters[State]`) are strictly case-sensitive on data.gov.in. The connector preserves the exact casing of filter keys as declared in the resource schema.
3. **No Field Invention**:
   * Never hardcode the Government Open Data License (GODL) or assume `open` access type unless verified.
   * Never inject geography from the user search request; use only values present in catalog metadata.
   * Record counts are recorded only from verified non-negative integer `total` fields.
   * Provenance mappings are created exclusively for fields actually present and extracted from the upstream response.

## Boundaries and Security Rules
1. **Resource Sampling Limits**: Samples are bounded to at most 100 rows per request and governed by `InspectionLimits` (default 500 rows, 10MB, cooperative deadline timeout).
2. **No Arbitrary Remote Code Execution**: Rejects archives, pickles, and unsupported binary formats.
3. **Bounded Inspector**: Uses `BoundedInspector` from the inspection module to examine columns, row counts, duplicate rates, and date ranges without unbounded memory consumption.
