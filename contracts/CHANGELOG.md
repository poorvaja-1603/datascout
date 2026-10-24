# Contract changelog

## 1.0.0

- Initial shared schemas for requirement extraction, requirements, datasets,
  evidence, matches, scores, source statuses, search, compare, dataset detail,
  and API errors.
- Freeze extraction caps: 200 characters per scalar, 20 entries per extracted
  array, 100 characters per array entry, and `minimum_records` from 1 through
  1,000,000,000. Whitespace is trimmed before size validation; over-cap values
  and empty array entries are rejected and never truncated.
- These caps are part of contract v1. Future contract versions may raise them,
  but must never lower them.
- `Requirement.source_span` uses zero-based, end-exclusive UTF-16 offsets with
  the matched source text.
- Dataset provenance records the source field path and ISO 8601 retrieval time.
- `POST /search` query length is limited to 1,000 characters after trimming;
  this API request cap is separate from the extraction-field caps.
- `openapi.yaml` is the canonical OpenAPI 3.1 contract for mocks, generated
  frontend types, and documentation, with Draft 2020-12 schemas. API Gateway
  REST does not import this document: B1 defines routes, Cognito authorization,
  and scopes directly in SAM, and CI checks SAM route/method/scope parity.
  Lambdas validate request bodies using the shared Zod schemas; API Gateway
  performs only basic required-body and payload-size checks.
- `SearchResponse` requires an `outcome`: `results`, `clarification_needed`,
  or `refused`. Clarification and refusal use fixed templates and cannot
  contain results or source statuses. No matches are a `results` outcome with
  a warning; partial source failures remain in source statuses, and total
  upstream failure is `upstream_unavailable`.
- Freeze the error-code catalog, HTTP status mapping, and retryability values
  in `src/schemas.ts`. Every `ErrorObject` fixture includes a request ID and
  retryability flag. Ten synthetic dataset fixtures include expected verdicts;
  they are test oracles only and do not assert real upstream dataset facts.
- OpenAPI examples have stable names matching their fixture files and can be
  selected in Prism with `Prefer: example=<example-name>`.
- B1 must configure API Gateway GatewayResponses for `401`, `403`, `413`,
  `429`, and `504` to return the shared `ErrorObject`; otherwise API Gateway
  returns its default `{"message": ...}` body.
- `npm run mock` serves all four contract routes from MSW handlers and
  schema-validated local fixtures. The mock uses documented local test tokens
  and example names; it is not a Cognito substitute and never calls upstream
  catalog services.
