# DataScout contracts

This package is the shared contract surface for all streams. Zod schemas,
inferred TypeScript types, and generated JSON Schema files are derived from the
same definitions in `src/schemas.ts`.

## Usage

Import the named schemas and types from `@datascout/contracts`. Run
`npm run build --workspace=@datascout/contracts` after changing a schema; this
type-checks the package, regenerates `json-schema/*.schema.json`, and bundles
the OpenAPI document at `dist/openapi.yaml`. Consumers such as mock servers,
frontend type generators, and documentation tools should use the bundle so
they do not need to resolve external schema files. Lint the source contract
with `npm run lint:openapi`.

## Shared ports and fakes

The package exports the shared `Connector`, `LlmClient`, `RequirementExtractor`,
`Inspector`, `Scorer`, `ExplanationService`, and `Tracer` interfaces together
with `CallContext` and the canonical contract types. Async operation methods
receive a `CallContext`; expected outcomes such as clarification, refusal, and
source failure stay represented as values. Operational failures use
`DataScoutError` with an `ErrorObject`-compatible code, safe message, and
retryability flag.

Fixture adapters (`FixtureConnector`, `FakeInspector`, `FakeExtractor`, and
`FakeExplainer`) allow pipeline work without production integrations. The
`FakeLlmClient` has canned extraction responses only for development corpus
cases REQE-001, REQE-002, and REQE-015; other inputs fail explicitly. Its
simulation modes support timeout, throttling, malformed JSON, and
injection-style output tests. `NoopTracer` and `InMemoryTracer` implement the
tracing port without sending data externally.

## Search outcomes and fixtures

`SearchResponse.outcome` is `results`, `clarification_needed`, or `refused`.
All outcomes include `source_statuses` and `results` arrays. A clarification
includes extracted requirements with a null topic, a fixed question selected
by `missing_topic` or `too_vague`, and no source results. A refusal has null
requirements, a generic message selected by `unsafe_request` or `out_of_scope`,
and no source results. No matches use the `results` outcome with an empty
results array and a warning; source failures are represented in
`source_statuses`, while total upstream failure uses an
`upstream_unavailable` error.

The canonical error catalog in `src/schemas.ts` fixes each error code's HTTP
status and retryability. `fixtures/datasets.json` contains ten synthetic,
hand-built fixtures with expected requirement verdicts; their `.invalid`
URLs and labels are test oracles, not real catalog records or owner-reviewed
claims. Search and error response examples are selectable by their named
OpenAPI examples. The mock server accepts `Prefer: example=<example-name>`.

## Local mock API

Run `npm run mock` from the repository root to serve the four OpenAPI routes
on `http://127.0.0.1:4010`. Set `HOST` or `PORT` to override the bind address
and port. The server is built from MSW request handlers and returns only
schema-validated fixtures; it does not call upstream catalogs or perform real
authentication.

Use `Authorization: Bearer mock-access-token` for all scopes,
`mock-search-token` for search only, `mock-read-token` for result and dataset
reads, or `mock-compare-token` for compare. Missing or unknown tokens return
the `unauthorized` ErrorObject; a known token without the route scope returns
the `forbidden` ErrorObject. Search and cached-result responses accept
`Prefer: example=<name>` using the named OpenAPI examples. For example,
`GET /results/fixture-search-clarification` returns the clarification fixture.
Dataset detail and compare use `dataset-detail` and `compare-synthetic`
examples respectively; compare requires the two fixture dataset IDs.

The canonical OpenAPI 3.1 document is not imported into API Gateway. The B1
SAM template defines deployed routes and Cognito authorization directly. CI
compares each SAM API event's path, method, and `AuthorizationScopes` with
`openapi.yaml`; the contract test reports a clear skip until
`backend/template.yaml` exists. Request bodies are validated by Lambda using
the shared Zod schemas; API Gateway is limited to basic required-body and
payload-size checks. Each environment supplies its own API origin and stage
to clients.

For B1, configure API Gateway GatewayResponses for `401`, `403`, `413`, `429`,
and `504` to return the shared `ErrorObject`; without these custom responses,
API Gateway returns its default `{"message": ...}` body instead.

## Contract v1 decisions

- `ExtractedRequirements` always has exactly the eight properties listed in
  `docs/plan.md`. Unknown scalar values are `null`; absent list values are
  empty arrays. Extra object properties are rejected.
- Extraction caps are exported constants and are enforced after trimming:
  scalar fields have a 200-character maximum; each extraction array allows at
  most 20 non-empty strings of at most 100 characters; `minimum_records` is
  either `null` or an integer from 1 through 1,000,000,000. Values above a cap
  are rejected, never truncated.
- JSON Schema marks extraction strings with
  `x-trim-before-length-validation: true`, because standard JSON Schema cannot
  trim values itself. Consumers must trim before applying its `maxLength`
  constraints; Zod performs that normalization during runtime validation.
- `Requirement.source_span` is either `null` or `{ start, end, text }`.
  Offsets are zero-based, end-exclusive JavaScript string (UTF-16 code-unit)
  offsets into the original query; the text length must equal `end - start`.
- Dataset provenance is keyed by normalized dataset field and records
  `{ source_field_path, retrieved_at }`. `retrieved_at` is an ISO 8601
  date-time with an explicit timezone.
- `DatasetDetail` carries the dataset, evidence, requirement matches, quality
  checks, access instructions, optional starter code, preprocessing guidance,
  next steps, and complementary dataset suggestions. Every join suggestion
  requires `manual_verification_required: true`.
- `SearchResult.score` is the numeric 0–100 total; `score_breakdown` carries
  the versioned component weights and points. Compare responses repeat these
  values per dataset and never declare a model-authored winner.
- Dataset source identifiers remain non-empty strings to permit future
  adapters. Dataset IDs use the `{source}:{native_id}` pattern in the plan.
- `ExtractedRequirementsSchema` is the strict model-output boundary. Schemas
  do not coerce or truncate invalid values.
- The `POST /search` query is limited to 1,000 characters (trimmed before the
  limit check); this is the API query cap, separate from extraction-field caps.
- The OpenAPI document references generated JSON Schemas instead of
  duplicating the contract definitions. Regenerate schemas before publishing
  an OpenAPI update.
- Standard JSON Schema cannot express every relational refinement. Runtime
  consumers must validate with the Zod schemas, which additionally enforce
  source-span offset/text consistency, unique compare IDs, and component
  points not exceeding component weights.
