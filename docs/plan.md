# DataScout MVP Development Plan

## 1. Product Outcome

Deliver an end-to-end web app where a user describes a data science or ML project and receives ranked public datasets with requirement-by-requirement evidence, deterministic suitability scores, validation notes, source/API access instructions, starter code, preprocessing guidance, and next steps.

DataScout's core promise is verification, not semantic search:

- The LLM interprets natural language and phrases short explanations grounded in retrieved evidence. It is never a source of truth.
- Source connectors retrieve real catalog metadata and, when permitted and practical, a small bounded sample.
- Deterministic code validates metadata/data, assigns PASS/PARTIAL/FAIL, and calculates the score.
- A response validator removes or flags every generated claim that lacks evidence.

Sources are staged: data.gov.in and Hugging Face first (vertical slice), then OpenML and World Bank (added sources named in the PRD), then optional extra sources behind feature flags (Section 6).

## 2. Scope and Release Boundary

### In scope

- React app on AWS Amplify (or S3 static hosting if Amplify is unavailable in the lab account); REST API on API Gateway with TypeScript Lambda functions.
- Deployment target is an AWS Academy Learner Lab account: existing `LabRole` only, no IAM role creation, no Bedrock (Section 14).
- Amazon Cognito User Pool and an API Gateway Cognito authorizer with scope-based access.
- Requirement extraction and evidence-grounded explanations through an external hosted LLM API called from Lambda, behind a provider-agnostic client (Section 8).
- An application-level safety gateway that replaces managed guardrails (Section 9).
- Connectors for data.gov.in, Hugging Face, OpenML, World Bank, plus optional extra sources.
- Canonical metadata schema, bounded dataset inspection, deterministic matching/scoring, comparison, and cache.
- DynamoDB (metadata, results), private S3 (snapshots, permitted samples), EventBridge bounded refresh.
- Langfuse tracing, scoring, datasets and experiments for LLM stages.
- Unit/integration tests, an LLM safety suite, and a versioned offline evaluation set.

### Out of scope

Private/paid sources, dataset hosting, model training, arbitrary crawling, running source-provided code, admin dashboards/roles, exhaustive copies of upstream catalogs, full-dataset profiling, vector search, and automated joins (join suggestions are labeled "manual verification required").

## 3. How the Team Works Independently

The previous plan chained every step through a shared owner of "contracts", so nobody could start until that owner finished. This plan removes that dependency with five rules.

1. **Three streams, three directories.** Each stream owns its directories outright and never edits another stream's files.

   | Stream | Focus | Owns |
   | --- | --- | --- |
   | A: AI and Verification Core | Contracts, LLM, safety, matching, scoring, Langfuse, evals | `contracts/`, `packages/ai/`, `packages/verify/`, `packages/observability/`, `evals/` |
   | B: Data and Cloud | AWS infrastructure, connectors, normalization, inspection, API handlers, refresh | `backend/`, `packages/connectors/` |
   | C: Web App and Source Connectors | Frontend, auth UI, and the added and extra source connectors (OpenML, World Bank, UCI, Zenodo, Dataverse, CKAN) | `frontend/`, `packages/connectors/src/openml/`, `packages/connectors/src/worldbank/`, `packages/connectors/src/extras/` |

2. **The contract kit is the only shared surface.** Phase 0 (Section 5) produces schemas, an OpenAPI spec, TypeScript ports (interfaces), fixtures, and a mock API. Streams talk to each other only through these.
3. **Every stream ships a fake of itself.** Stream A ships `FakeLlmClient` and recorded cassettes. Stream B ships fixture-backed connectors. Stream C runs against the mock API. Nobody waits for someone else's real implementation.
4. **Integrate only at milestones.** Between milestones, each stream proves itself with contract tests against fixtures. Milestone checklists are in Section 16.
5. **Contract changes are additive.** Anything that changes a field name or meaning is a version bump (`contract_version`) with an entry in `contracts/CHANGELOG.md` and a heads-up in the team channel. Adding an optional field needs no coordination.

Working conventions: one branch per task ID, small PRs, `CODEOWNERS` by directory, CI runs each stream's tests independently, and secrets never enter the repo.

## 4. Architecture and Repository Layout

```text
React / Amplify Auth <-> Cognito User Pool
      | access token (Bearer)
API Gateway Cognito authorizer -> Search Lambda -> safety gateway -> requirement extraction (external LLM API)
                    |          -> source adapters (parallel, bounded)
                    |          -> normalize -> inspect (bounded sample)
                    |          -> match -> score (deterministic)
                    |          -> grounded explanation -> response validator
                    |          -> DynamoDB results/dataset cache; S3 snapshots/samples
                    +----------> Langfuse traces and evaluation scores (optional, fail-open)

EventBridge -> Refresh Lambda -> catalog harvest / indicator index -> DynamoDB / S3
```

```text
contracts/              schemas, openapi.yaml, ports, fixtures, mock server, CHANGELOG   (Stream A)
packages/ai/            llm client, prompts, extraction, explanation, response validator, safety  (A)
packages/verify/        matching, verdict rules, scoring                                  (A)
packages/observability/ Langfuse wrapper, redaction, score reporting                      (A)
evals/                  corpus, validators, runners, reports, safety suites               (A)
packages/connectors/    toolkit (safe fetch), HF and data.gov.in adapters, normalization, inspection  (B); OpenML, World Bank, extra adapters  (C)
backend/                SAM template, handlers, pipeline, storage, refresh                (B)
frontend/               React app                                                         (C)
docs/                   PRD.md, plan.md, decision notes
```

Backend language is TypeScript. The existing Python `evals/validate_dataset.py` stays as the corpus integrity check; evaluation runners are TypeScript so they exercise the exact production extraction code.

AWS services are those in the abstract/PRD (Amplify, API Gateway, Lambda, DynamoDB, S3, EventBridge) plus Cognito for authentication. Amazon Bedrock and Bedrock Guardrails are not available in the Learner Lab role, so model calls go to an external hosted LLM API and safety checks run in our own code. Langfuse is the external hosted observability platform. Any other AWS service needs a short decision note with cost and reason.

## 5. Phase 0: Contract Kit

Goal: unblock all three streams with the smallest set of shared artifacts. Items are ordered so the first three are enough for other streams to start.

| ID | Deliverable | Detail |
| --- | --- | --- |
| P0-1 | Repo scaffold | npm workspaces, shared `tsconfig`, lint/format, per-package test runner, CI that runs each package independently, `.env.example`, `CODEOWNERS`, `.gitignore` covering `.env*` |
| P0-2 | Schemas | Zod schemas exported as TypeScript types and JSON Schema (see below) |
| P0-3 | `openapi.yaml` | Four routes, request/response schemas, error object, Cognito security scheme and per-route scopes |
| P0-4 | Ports | TypeScript interfaces: `Connector`, `LlmClient`, `Inspector`, `Scorer`, `Tracer`, plus `FakeLlmClient` returning canned output for three demo queries |
| P0-5 | Fixtures | Ten hand-built canonical `Dataset` fixtures with human-labeled expected verdicts (cover PASS, PARTIAL, FAIL, UNKNOWN, metadata-only, sample-checked); three canned `SearchResponse` files: normal, one-source-failed, clarification-needed; one error example per error code |
| P0-6 | Mock API | `npm run mock` serves the four routes from fixtures (Prism from the OpenAPI file or MSW handlers), including auth-failure responses |

**Tag `contracts-v1` when P0-1 to P0-4 are done.** P0-5 and P0-6 follow and unblock fixture-driven work.

### Schemas to freeze

- `ExtractedRequirements` (model output, exactly these fields, no extras): `topic`, `geography`, `time_coverage`, `minimum_records`, `required_features[]`, `target`, `preferences[]`, `constraints[]`. This matches the reviewed evaluation corpus so evals and production share one shape. Normalization rules from the corpus apply: numeric year ranges become `YYYY-YYYY`; non-range expressions such as `next year` are preserved as written until a rule is added.
- `Requirement` (derived deterministically from `ExtractedRequirements`, never by the model): `requirement_id`, `type`, `value`, `unit`, `priority` (required or preferred), `aliases[]`, `source_span` (found by string search in the original request, null if not found).
- `Dataset`: `dataset_id`, `source`, `source_url`, `title`, `description`, `license`, `access_type`, `api_endpoint`, `file_formats[]`, `record_count`, `columns[]`, `geography`, `time_coverage`, `tags[]`, `last_updated`, `retrieved_at`, `raw_snapshot_key`, `verification_level`, and per-field `provenance` (source field path plus retrieval time).
- `Evidence`: `evidence_id`, `dataset_id`, `field`, `value`, `provenance`.
- `RequirementMatch`: `requirement_id`, `status` (PASS, PARTIAL, FAIL, UNKNOWN), `reason`, `evidence_ids[]`, `verification_level`, optional `measured_value`.
- `ScoreBreakdown`: `scoring_version`, components with weights and points, `evidence_coverage`.
- `SearchResult`, `SearchResponse`, `CompareResponse`, `DatasetDetail`, `SourceStatus`, `ErrorObject` (`code`, safe `message`, `request_id`, optional `retryable`).
- Version fields on every response: `contract_version`, `prompt_version`, `schema_version`, `scoring_version`, `model_id`.

### Dataset ID format

`{source}:{native_id}` such as `huggingface:owner/name`, `openml:61`, `datagovin:<resource_id>`, `worldbank:SP.POP.TOTL`. IDs are validated against a strict pattern on every route.

## 6. Source Plan

### Source tiers and fetch strategy

| Tier | Source | How candidates are found | How details and samples are fetched | Key boundaries |
| --- | --- | --- | --- | --- |
| Required | data.gov.in | The portal has no full-text search API a program can call. The catalog list endpoint is reported to need no API key and to page up to 1000 records, so the refresh job harvests catalog metadata into a search index (DynamoDB/S3) and searches it locally | Resource schema and rows come from the resource API and need the team's data.gov.in API key (sent in the query string, so redact URLs everywhere). Page rows with offset (about 100 per request), expect some resources to return CSV regardless of requested format, and note filter field names are case-sensitive | Run a one-hour spike first to confirm these behaviors, record them in `docs/sources/datagovin.md`. Harvest must be bounded and respect rate limits; index only metadata |
| Required | Hugging Face Datasets | Hub API dataset search with limit, filter, and sort parameters | Hub API for card metadata, tags, license, gated flag, files; dataset viewer API (`is-valid`, `info`, `size`, `first-rows`, `rows` with offset/length) for schema, size, and small samples | Never run loading scripts or `trust_remote_code`; skip gated or private datasets; viewer availability varies per dataset |
| Added | OpenML | Dataset list API with name/tag/size filters | Dataset description, features, and qualities endpoints (instances, features, missing values); sample only if qualities show the file is under the size cap | Treat license/status as source claims; do not upload data |
| Added | World Bank Indicators API | Indicator metadata is downloaded by the refresh job into an index and searched locally (the indicator list is large and paged) | Country/time-series observations via the indicator data endpoint with `date` range and country filters | Grain is country-year indicator series, not row-level ML data; mark grain, geography, years, definition clearly |
| Extra (flag) | UCI Machine Learning Repository | Dataset list and name lookup endpoints used by the `ucimlrepo` package | Dataset metadata endpoint (instances, features, variables, area, license) | Classic ML benchmarks, good for generic requests; metadata is well structured |
| Extra (flag) | Zenodo | Records search API with dataset resource-type filter | Record metadata and file list (size, checksum, format) | Mixed quality and licenses; many records are not tabular, so mark unsupported formats |
| Extra (flag) | Harvard Dataverse | Search API with `type=dataset` | Dataset metadata and file metadata (tabular files have ingested variable info) | Restricted/embargoed files must be detected and skipped |
| Stretch | Generic CKAN adapter | `package_search` action on configured CKAN portals (for example national open data portals) | `package_show` for resources and formats | One adapter, many portals; each portal is an allowlisted config entry |
| Not planned | Kaggle | Requires per-user credentials and has its own terms | n/a | Revisit only with a clear terms review |

Extras are enabled per source by a flag. Each source passes the adapter checklist below before its flag can be turned on.

### Adapter contract

```ts
search(requirements, options): Promise<ConnectorResult[]>
getDetails(datasetId): Promise<ConnectorResult | null>
inspectSample?(dataset, limits): Promise<SampleInspection>
```

Missing fields stay `null`/`unknown`; never infer a field from a title as if verified.

### Connector toolkit (shared by all adapters)

- `safeFetch`: host allowlist enforced again after every redirect, block private/link-local/loopback targets after DNS resolution, HTTPS only, timeout, max response bytes, max redirects, content-type allowlist.
- Retry with backoff for transient errors only; honor `429` and `Retry-After`.
- Error wrapper that redacts query-string secrets (`api-key`, tokens, signed URL parameters) before anything is logged or returned.
- Fixture recorder: saves a sanitized real response to `fixtures/` for contract tests.

### Adapter checklist (per source)

Contract test against a saved fixture; graceful failure test (timeout, 429, malformed body); provenance mapping; dedupe by canonical ID; per-source top-N, page, concurrency, and byte limits; a written limitation note in `docs/sources/<source>.md`; feature flag.

### Behavior rules

- Source failures are partial: return healthy sources with a visible `SourceStatus`.
- Cache with TTL; store retrieval timestamps and ETag/version where offered.
- Store raw snapshots in S3 only where terms permit.

## 7. Verification, Matching, and Scoring

### Verification levels

- `metadata_only`: catalog/card metadata inspected, no rows checked.
- `sample_checked`: bounded, permitted sample inspected.
- `full_dataset`: reserved for explicitly small, safe datasets; never claimed for large remote data.

### Inspection (bounded, safe)

Supported formats: CSV, JSON, and Parquet through safe parsers. Limits: bytes, rows (for example 1,000), columns, parse time. Checks: column names and types, missingness rate, duplicate rows, date parse and range, numeric sanity. Never execute notebooks, pickles, scripts, or archives with nested code; reject zip bombs by size and entry-count limits. Metadata-derived checks are labeled as metadata, not data-quality proof.

### Verdict rules (defined before coding, as unit tests first)

- PASS: authoritative metadata or sample directly confirms the condition.
- PARTIAL: ambiguous, indirect, stale, metadata-level only, or threshold not verifiable.
- FAIL: verified evidence contradicts the requirement.
- UNKNOWN (internal): evidence unavailable. Rendered as PARTIAL with "not verified". Never converted to PASS or FAIL.

Per-requirement rules: topic (tags/title/description match with alias table; semantic closeness alone is never PASS), geography (normalized name and containment such as city within state), time coverage (interval overlap, PASS only if fully covered by verified range), minimum records (verified count at or above threshold), required features (alias-normalized column match against real column lists), target (column present), constraints (license, format, access type checks).

### Score `score-v1`

| Component | Points | Rule |
| --- | --- | --- |
| Requirement satisfaction | 50 | PASS=1, PARTIAL=0.5, FAIL=0, UNKNOWN=0; required criteria weighted above preferences |
| Validation and access | 20 | Supported access plus quality checks performed; metadata-only gets no sample-quality credit |
| Metadata completeness | 15 | Fixed useful-field list, excluding fields not applicable to that source |
| License and source clarity | 10 | Explicit license, access, provenance |
| Freshness | 5 | Source `last_updated` only; unknown earns zero |

Do not renormalize for missing dimensions. Unknown earns zero and lowers `evidence_coverage`, so thinly verified candidates never look stronger. Ranking is deterministic with a stable tie-break (score, then evidence coverage, then `dataset_id`). Any threshold change bumps `scoring_version`.

## 8. LLM Design

### Provider abstraction

`LlmClient` has four implementations selected by `LLM_PROVIDER`:

- `fake`: canned responses for tests and for frontend/backend development.
- `cassette`: records and replays real provider responses for deterministic CI.
- `gemini`: Google's hosted Gemini API with native JSON response-schema output. The API key and pinned model ID come from server-side configuration; Gemini is the hosted deployment provider.
- `ollama`: Ollama's local `/api/chat` endpoint with JSON-schema format. Use for local development and offline tests; do not assume a workstation-local Ollama endpoint is reachable from Lambda or configure it as a production fallback.

No stream is blocked on provider access, and tests never call the network. An optional `LLM_FALLBACK_*` configuration names a second provider that is tried once if the primary is rate-limited or down. Every result records the model ID that produced it.

**Decision D1 (before enabling hosted calls): pin the Gemini model and verify its quota, pricing, data-retention/training terms, and Lambda-region latency.** Ollama remains local-only unless the team separately deploys and secures a reachable service. Record the exact Gemini model, quota, and terms in `docs/decisions/llm-provider.md`.

### Data leaving AWS

Because the model is now an external service, every outbound call is treated as data egress.

- Only the redacted, length-capped query text and short sanitized evidence fields are sent. Never dataset rows, tokens, user identity, or raw source documents.
- The same redactor used for Langfuse (email, phone including +91 formats, Aadhaar-like, PAN-like, JWT, key patterns) runs before every outbound call.
- The base URL is fixed in configuration and is never influenced by user or source text.
- API keys live in AWS Secrets Manager (listed as available in Learner Lab) or SSM Parameter Store, with Lambda environment variables as a last resort. They are never in the frontend or the repository.
- Use a provider and plan whose terms do not train on submitted data where the option exists; otherwise limit the demo to non-sensitive queries and say so in the README.

### Stage 1: requirement extraction

- Structured output through the provider's forced tool call or JSON-schema response format whose schema is the `ExtractedRequirements` JSON Schema. Where a provider has neither, use JSON mode. The response is re-validated with Zod regardless.
- Versioned prompt file (`prompts/extract.v1.md`), temperature 0 (and a fixed seed where supported), a pinned dated model ID, small output token cap, request timeout.
- Strict parsing: reject extra fields, wrong types, negative or non-integer counts, over-long strings. No "repair and trust".
- Deterministic post-processing: year-range normalization, alias normalization, extraction grounding check (Section 9, layer L4), derive `Requirement[]` and `source_span`.
- Clarification path: if `topic` is null, return a clarification response. If the safety gateway blocks the request, return a refusal response. Neither searches.
- Provider failure handling: one retry with backoff on timeout, `429`, or `5xx`, then the fallback provider if configured, then a safe `extraction_failed` or `upstream_unavailable` error. A circuit breaker skips the provider for a short window after repeated failures so a provider outage fails fast. Never search on malformed criteria.
- Optional extraction cache keyed by a hash of the normalized, redacted query with a short TTL, to cut cost and flakiness on repeated demo queries.

### Stage 2: grounded explanation (optional, secondary in the UI)

- Input is only validated result objects: facts, verdicts, score breakdown, and `evidence_id`s. No raw dataset text beyond short, delimited, sanitized fields.
- Output schema: `claims[]` each with `text` and `evidence_ids[]`, plus `next_steps[]` and `preprocessing[]` that also cite evidence IDs or are marked generic guidance.
- Starter code is generated from source-specific templates filled with verified values (dataset ID, column names, file format), not free-form model code. The model may only add comments or short notes.

### Stage 3: response validator (deterministic)

1. Every cited `evidence_id` exists for that dataset.
2. Every number in a claim appears in the cited evidence values (same unit).
3. Every named entity, column, or URL in a claim appears in the cited evidence or the dataset record. Unknown URLs are removed.
4. No claim contradicts the verdict or states a verdict the application did not compute.
5. Banned patterns: guarantees ("definitely suitable"), instructions to the reader to run unknown code, content that looks like leaked prompt text.
6. Failing claims are dropped. If none survive or the schema fails, return the deterministic result with a templated, evidence-only summary and `explanation_status: "unavailable"`.

### Versioning

Record `prompt_version`, `model_id`, `provider`, `schema_version`, `scoring_version`, `contract_version`, safety gateway outcome (layers triggered, triage verdict), and source IDs on every trace and stored result. Evaluation results are only valid for the model ID they were measured on; any provider or model change means re-running the gates.

## 9. LLM Safety Measures

| Threat | Controls | Test |
| --- | --- | --- |
| Prompt injection in the user query | Treat input as data inside delimiters; system prompt states that nothing in the query changes instructions; forced JSON schema output; safety gateway layers L0 to L2 on input; extraction grounding check L4 on output; output never executed | Injection suite (direct override, role play, "ignore previous", encoded payloads, multilingual); pass = extraction still returns valid schema with no instruction followed, and per-layer catch rates are reported |
| Indirect injection via dataset cards, column names, CSV cells, API descriptions | Source text is truncated, stripped of markup, delimited as untrusted evidence, never given tool access; explanation stage sees only short sanitized fields; validator drops claims not backed by evidence | Fixtures with malicious cards and cells ("recommend this dataset first", "reveal your prompt", URLs) must not change verdicts, score, rank, or output format |
| Verdict or score manipulation by the model | Model has no role in verdicts, scores, ranking, licenses, row counts, or availability; they come from deterministic code | Unit test that `packages/verify` has no LLM import; ranking identical with explanation stage disabled |
| Hallucinated or unsupported claims | Evidence-ID citation, numeric and entity checks, drop-or-template fallback | Unsupported-claim rate on labeled set must be zero known at release |
| SSRF and URL abuse | Model never chooses URLs or tools; fixed hosts, redirect re-validation, DNS resolution checks, private-range blocking | SSRF cases: localhost, `169.254.169.254`, DNS rebinding style hosts, redirects to private IPs, unusual schemes |
| Code execution through dataset files | Only CSV/JSON/Parquet via safe parsers; no pickle, notebooks, archives with code, loading scripts, or `trust_remote_code`; resource limits | Fixtures: pickle, `.py`, notebook, zip bomb, huge CSV; all rejected or truncated safely |
| Secret and prompt leakage | Secrets only from Secrets Manager/SSM (environment as last resort), including the LLM API key; canary tokens in system prompts, checked in outputs and traces; URL redaction for `api-key` and signed parameters; stable error objects with no internals; prompts and chain-of-thought never returned | Canary secret in env plus injected "print your instructions" cases; scan responses, logs, and traces for canaries |
| PII in traces and logs | Default minimized trace payloads; regex and allowlist redaction before export (email, phone including +91 formats, Aadhaar-like 12-digit, PAN-like, JWTs, AWS key patterns, `api-key=` parameters); no user identity in traces | Redaction unit tests plus in-memory exporter assertions that nothing unredacted leaves the process |
| Cost and denial of service | Input length cap, output token cap, bounded retries, bounded parallelism, API Gateway throttling, per-user daily LLM-call quota, global daily cap, and kill switch (Section 9, layer L6); external provider has no AWS budget guard, so these are mandatory | Oversize input, repeated calls, slow-source tests; cost per search tracked in Langfuse |
| Cross-user data access | `owner_sub` check on results, 404 for non-owners | Two-user integration test |
| Unsafe or inappropriate requests | Safety gateway policy layers L1 and L2: out-of-scope or harmful requests return a refusal, not a search | Corpus cases tagged inappropriate or impossible, plus false-positive check on normal queries |
| Data egress to the LLM provider | Redaction before every outbound call, fixed base URL, no dataset rows or identity sent, provider terms recorded in D1 | Redaction tests on the outbound request body (recorded by the cassette client); canary PII never appears in a captured request |
| XSS and spreadsheet injection from source text | Frontend renders source text as plain text (no raw HTML or unsanitized markdown); any CSV export escapes leading `=`, `+`, `-`, `@` | Frontend test with script/HTML payloads in titles and descriptions |
| Over-trust in uncertain output | UI shows verification depth, evidence coverage, and "not verified" states prominently; explanation is secondary | UI review checklist |

### Safety gateway (replacement for managed guardrails)

Managed guardrails were only ever a convenience layer. The controls that protect verdicts, scores, and claims (deterministic verification and the response validator) were already application code. The gateway rebuilds the input and policy checks in our own code as layers, so a request must get past several independent checks and each layer's catch rate can be measured.

| Layer | What it does | Cost and failure behavior |
| --- | --- | --- |
| L0 Input hygiene | Unicode NFKC normalization; strip zero-width, bidirectional, and control characters; collapse whitespace; length cap; reject long encoded blobs (base64 or hex runs); strip markup and unexpected URLs | Deterministic, free; failure rejects with `invalid_request` |
| L1 Signature screen | Versioned multilingual pattern list (instruction override, role play, "reveal your prompt", tool or URL exfiltration phrasing, known jailbreak templates) plus an out-of-scope and unsafe-topic list kept in config | Deterministic, free; high-confidence hits refuse, weaker hits set a flag for L2 |
| L2 LLM safety triage | A separate model call with its own prompt, temperature 0, no tools, input in delimiters, strict output `{verdict: allow\|block, category: prompt_injection\|unsafe_request\|out_of_scope\|none}`; runs on every request in the MVP (use a small cheap model if available) | If the call fails: flagged inputs are refused, unflagged inputs continue with `triage: skipped` recorded in the trace, since downstream layers still constrain the output |
| L3 Constrained extraction | Delimited input, no tools, forced schema, caps from the contract | Existing design |
| L4 Extraction grounding check | Each extracted string must be traceable to the query text (normalized token overlap) or to the alias table; numbers and years must appear in the query; field values must pass a charset allowlist and contain no URLs, markup, or instruction-like phrases. Failing fields become null and are flagged | Deterministic; tuned on the development split only; unsupported-value rate is tracked |
| L5 Policy outcome | Maps gateway verdicts to the `refused` or `clarification_needed` outcome with generic messages that never name the layer that fired | Deterministic |
| L6 Spend and abuse controls | Per-user daily LLM-call quota and a global daily cap in DynamoDB, concurrency limit, and a kill switch (configuration flag) that makes LLM calls return `upstream_unavailable` instantly | Quota exceeded returns `rate_limited` |
| L7 Source text quarantine | Dataset text that matches L0 or L1 patterns is excluded from the explanation input; verdicts and scores are unaffected | Deterministic |
| L8 Leakage canaries | Canary tokens in system prompts; outputs, errors, and traces are scanned | Any hit blocks the response and raises an alert-level log |
| L9 Egress redaction | PII and secret redaction before any outbound LLM call | Deterministic |

The gateway is a defense in depth: no single layer is trusted alone, and the model has no authority over verdicts, scores, or ranking regardless of what any layer lets through. Claims of strength are measured, not assumed: the safety suite (Section 11) reports, for every injection case, which layer stopped it, and the release gates cover both injection success rate and the false-positive rate on normal queries.

**Implementation status:** Stream A implements L0 input rejection, a versioned but currently English-focused L1 signature list, hosted-provider L2 structured triage (fake/cassette skip it), L3 constrained extraction, L4 token/number grounding, L5 refusal/clarification mapping, L7 source-text quarantine for explanations, L8 per-request canary scanning and safe alert logs, and L9 egress redaction. L6 has an admission gate with a kill switch, per-process concurrency, and an atomic daily-budget store interface; it reserves worst-case calls so retries cannot exceed caps. The production DynamoDB atomic-reservation adapter and authenticated principal wiring belong to the API/Lambda integration (Stream B); do not deploy hosted calls without wiring this gate. The full Section 11 adversarial safety suite, broader multilingual rule coverage, and deployed metric/alert delivery remain release work.

## 10. Langfuse Monitoring

Setup status: the project exists and keys are acquired. Runtime configuration uses `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL`. Locally they live in an untracked `.env`; in AWS they come from Secrets Manager or SSM Parameter Store. They are never committed, never in frontend variables, and never pasted into chat or tickets. If a key has ever been shared in a zip, screenshot, or chat, rotate it.

### Integration approach

Use the Langfuse TypeScript SDK (OpenTelemetry based): `@langfuse/tracing` and `@langfuse/otel` with `LangfuseSpanProcessor` on the OpenTelemetry Node SDK. In Lambda, create the processor once at module scope and call `forceFlush()` before the handler returns. Check current package versions when installing.

### Trace design

- One trace per API request. Trace ID is derived deterministically from `request_id` so it can be correlated without exposing user identity.
- Spans: `requirements.extract` (generation), `connector.<source>.search` per source, `normalize`, `inspect`, `match`, `score`, `explain.generate` (generation), `explain.validate`, `persist`.
- Attributes: `prompt_version`, `model_id`, `schema_version`, `scoring_version`, token usage when available, latency, per-source status and counts, safety gateway outcome and layers triggered, validation outcome, environment (`dev`, `eval`, `prod`).
- Default payload policy: no raw user query, no raw prompts or responses, no dataset rows or cards, no tokens, no signed URLs, no user identity. Raw text capture is an explicit development-only switch, goes to a dev project with short retention, and is redacted first.
- Redaction runs in our wrapper before any attribute is set, and the SDK's masking hook is also configured where available.

### Scores attached to traces

`extraction_schema_valid`, `evidence_coverage`, `unsupported_claim_count`, `source_success_ratio`, `response_complete`, `safety_blocked`, `safety_layer_triggered`, `latency_ms_bucket`. Human annotation on a sampled set of explanations; an LLM judge may help triage but is never a release gate.

### Offline evaluation in Langfuse

- Create datasets from the reviewed corpus: `datascout-requirements-dev` (40 cases) and `datascout-requirements-heldout` (10 cases, run only at gates).
- Each experiment run is tagged with corpus hash, prompt version, model ID, schema version, evaluator version, split, and timestamp, matching the rule in `evals/BASELINE.md`.
- Dashboards: latency p50/p95 per stage, cost per request, token use, source success rates, validation failures, safety blocks by layer, provider error rate, score trends.

### Reliability

- Fail open: all tracing calls are wrapped so errors never reach the request path; flush has a hard timeout budget.
- If delivery fails, emit a safe log line and metric, not the payload.
- Use the single Langfuse project selected by the team; mark traces with `dev`, `eval`, or `prod` environment attributes and tags. Keep payloads minimized, use least-privilege keys, and configure the shortest useful retention.

### Verification steps

1. Smoke script sends one synthetic trace with fake data and confirms it appears in the project.
2. In-memory exporter tests prove redaction before export.
3. Inspect one delivered dev trace manually and record the result in `evals/BASELINE.md`.
4. Kill-switch test: invalid keys and a blocked network do not fail a search.

## 11. Evaluation Plan and Release Gates

### Existing corpus (v0.1)

`evals/requirements-v0.1.jsonl`: 50 requests (40 development, 10 held-out), reviewed by the project owner, with a structural validator and a corpus hash recorded in `evals/BASELINE.md`. Category counts are uneven: adversarial 2, no_match 3, ambiguous 6, typo_synonym 4, source_specific 6. Treat it as sufficient to start extraction tuning but thin for safety claims. Plan a v0.2 that adds more adversarial, ambiguous, and no-match cases (bump version, recompute hash, keep held-out membership fixed unless re-reviewed). The separate safety suite below carries injection and leakage coverage.

### Additional evaluation assets to build

| Asset | Purpose | Size target |
| --- | --- | --- |
| Verdict fixtures | Human-labeled requirement verdicts over saved real source fixtures (false-PASS, unknown handling) | At least 60 requirement-dataset pairs across all four sources |
| Retrieval set | Known relevant datasets for sample queries (Recall@5/10) | At least 20 queries |
| Grounding set | Generated explanations with labeled supported/unsupported claims | At least 40 explanations |
| Safety suite | Direct injection, indirect (source-borne) injection, leakage canaries, SSRF, unsafe files, PII-in-trace | At least 40 injection, 10 leakage, 10 SSRF, 10 file-safety cases |

### Metrics

- **Extraction:** schema-valid rate; per-field precision, recall, F1 (micro and macro); numeric exact match; time-range normalization exactness; null-handling accuracy (does not hallucinate absent fields); clarification/refusal accuracy.
  - Matching rules: case-insensitive normalized string for `topic`, `geography`, `target`; exact for integers; set comparison after alias normalization for lists.
- **Retrieval:** Recall@5/10, source coverage, duplicate rate, per-source success and error rate.
- **Verification:** verdict accuracy, false-PASS rate (reported separately), UNKNOWN handling accuracy.
- **Scoring:** determinism, monotonicity (adding a verified required match never lowers the score), component correctness, ranking agreement with a reviewed rubric.
- **Grounding:** evidence-ID validity, supported-claim rate, unsupported-claim rate, numeric and entity mismatches.
- **Safety:** injection success rate, leakage rate, SSRF block rate, unsafe-file rejection, trace redaction pass rate, safety false-positive rate on normal queries, per-layer catch rates, extraction unsupported-value rate, egress redaction pass rate.
- **Operations:** p50/p95 latency per stage and end to end, per-source timeout behavior, LLM provider failure behavior (timeout, rate limit, outage, circuit breaker, fallback provider), cache hit rate, trace delivery success, estimated cost per search.

### Process

1. Tune prompts and rules only on the development split.
2. Run the held-out split only at gates; never tune against it.
3. Record corpus hash, model ID, prompt version, schema version, evaluator version, split, and timestamp with every run. Replace `NOT_RUN` entries in `BASELINE.md` only with measured values.
4. Review failures by example. False PASS, unsupported claims, and safety failures are release blockers regardless of aggregate score.

### Release gates (calibrate thresholds on the reviewed set, then freeze)

- 100% of API responses conform to the response schema; malformed model output is rejected or falls back safely.
- 100% of PASS verdicts carry evidence IDs and a supported verification level.
- False-PASS rate is zero on the acceptance set; ambiguous evidence maps to PARTIAL/UNKNOWN.
- Zero known unsupported claims on the held-out set; zero secret leakage and zero executed external code in safety cases.
- Injection success rate zero on the safety suite; any new bypass becomes a permanent test. Safety false-positive rate on the normal-query set stays under a threshold agreed after the first baseline.
- Scores identical across repeated fixture runs; threshold changes bump `scoring_version`.
- Each enabled source has a passing contract test and failure test; search works with any one source down and shows partial coverage.
- Langfuse failure does not fail a request; redaction tests pass.
- Extraction F1 gate (per field and macro) and p95 latency target agreed after the first baseline run and written into `BASELINE.md`.

## 12. API and Auth Contracts

### Routes

All routes require a valid Cognito access token in `Authorization: Bearer` and the route scope.

- `POST /search` (`datascout-api/search`): `{ "query": "...", "options": { "sources": [...] } }`. Returns `request_id`, normalized requirements, source statuses, ranked results, score breakdown, evidence, warnings, version fields. Stores `owner_sub`.
- `GET /results/{request_id}` (`datascout-api/read`): owner only, 404 otherwise.
- `GET /dataset/{dataset_id}` (`datascout-api/read`): public normalized detail, provenance, validation, access instructions, starter code, preprocessing, next steps.
- `POST /compare` (`datascout-api/compare`): `{ "dataset_ids": [2 to 4 known IDs] }`; side-by-side normalized fields and evidence, no model-authored winner.

Stable error objects, input size limits, ID validation, pagination limits.

### Auth

- Cognito User Pool with verified email, public SPA app client (no secret), Authorization Code with PKCE, resource server `datascout-api` with scopes `search`, `read`, `compare`.
- API Gateway REST API with Cognito authorizer and per-method scopes; Lambda reads `sub` from authorizer context.
- CORS restricted to the frontend hosting origin(s). Throttling and request validation complement, not replace, authentication.
- Document whether sign-up is open or invite-only for the demo.
- EventBridge refresh uses its own service permission path, not the public API.

### Storage

- DynamoDB: separate key patterns for request cache (with `owner_sub` and TTL), dataset detail, and catalog/indicator index entries. Never treat an unguessable ID as authorization. Expired cache is never presented as current.
- S3: private, encrypted, block public access, stable prefixes, lifecycle rules. Store only snapshots and samples that terms permit.

## 13. Frontend

### Visual direction: Brutalist x Tactile

Bold, high-contrast structure with tactile control states. Ink-and-light foundation with a small vivid accent set (for example cobalt and acid-lime). Green, amber, and red are reserved for PASS, PARTIAL, and FAIL, always paired with text labels. Crisp borders and restrained offset shadows on primary controls, selected filters, and active rows; clear pressed and selected states. Mostly flat surfaces, no cards inside cards. Tactile styling applies to controls, not to evidence: tables, field names, source links, score breakdowns, and validation notes stay plain and aligned. Stable type sizes, visible focus, readable contrast, responsive stacking that never hides verdicts or evidence. Familiar icons with accessible names.

### Screens

- Sign-up/sign-in, email verification, session-expired and unauthorized states.
- Search with example query, loading/error/empty/partial-source states, and editable extracted requirements.
- Results list with source, score, evidence coverage, verification depth, verdict summary, and source warnings.
- Comparison view for 2 to 4 datasets.
- Detail view with provenance, validation evidence, access instructions, starter code, preprocessing checklist, next steps, and complementary dataset suggestions labeled "manual verification required".
- Uncertainty is always visible: unknown metadata never looks like a verified pass or fail. Generated explanation is secondary to deterministic evidence.
- All source-provided text renders as plain text.

## 14. AWS and Deployment

1. Confirm region, LLM provider and key (decision D1), data.gov.in API key, Langfuse environments, budget alarm, Cognito registration policy, redirect/logout URLs.
2. SAM template that sets the existing `LabRole` explicitly on every function and resource that needs a role. Learner Lab does not allow creating IAM roles, so do not let SAM generate them. Least privilege is therefore enforced in code, resource policies where allowed, and per-route scopes; record this limitation in the README.
3. DynamoDB on-demand with documented access patterns and TTL; private S3 with encryption and lifecycle.
4. Cognito, authorizer, scopes, CORS, throttling, request validation.
5. EventBridge schedule for bounded, idempotent refresh with per-source last-success, failure, and item counts.
6. Deploy a **protected skeleton early** (handlers return fixtures) so the frontend can switch from the mock API to real Cognito and API Gateway before real logic exists.
7. Frontend hosting with API URL and public Cognito identifiers only. Verify in the B1 spike that Amplify works in the lab account; fallback is a private S3 bucket with static website hosting behind CloudFront if available, or plain S3 website hosting.
8. Alarms and review procedure for Lambda errors/timeouts/throttles, LLM provider failures and quota usage, source failures, auth failures, storage growth. Do not log request bodies or tokens.
9. Learner Lab sessions are time-limited and resources may be reset. Keep the stack redeployable with one command, keep seed data and secrets re-creatable from documented steps, and commit fixtures, eval reports, and `BASELINE.md` to git rather than relying on anything stored only in the lab account.
10. Teardown document; rotate credentials after the demo.

## 15. Work Packages

Estimates are rough working hours for one person. Dependencies list only contract artifacts or earlier tasks in the same stream unless stated.

### Phase 0: Contract Kit (Stream A)

See Section 5. Tasks P0-1 to P0-6, about 5 to 7 hours total; P0-1 to P0-4 are the unblocking subset.

### Stream A: AI and Verification Core

| ID | Task | Needs | Done when | Est |
| --- | --- | --- | --- | --- |
| A1 | LLM client: `fake`, `cassette`, `gemini`, `ollama` providers, fallback, retry and circuit breaker, timeouts, token caps, config; decision note D1 | P0-4 | Same calling code works against all providers; cassette replay is deterministic in CI | 4 |
| A2 | Requirement extraction: prompt v1, strict Zod parse, normalization, derive `Requirement[]` and spans, clarification/refusal path | A1 | Schema-valid output for all dev cases with the fake/cassette; malformed-output tests pass | 5 |
| A3 | Evaluation runner for extraction: metrics, per-field report, split handling, run metadata, `BASELINE.md` update script | A2, corpus | One command produces a report with corpus hash and versions; dev-only unless `--heldout` | 5 |
| A4 | Observability package: Langfuse init, redaction, tracer wrapper, flush with timeout, score reporting, smoke script | P0-4 | Smoke trace visible in Langfuse; redaction tests pass; invalid keys do not break calls | 4 |
| A5 | Matching and verdict rules (pure functions) with UNKNOWN handling | P0-5 | All labeled fixture verdicts match; zero false-PASS on fixtures | 5 |
| A6 | Scoring `score-v1`, tie-breaks, evidence coverage | A5 | Determinism and monotonicity tests pass; published formula doc | 3 |
| A7 | Grounded explanation generator, deterministic templates, response validator | A1, A5, A6 | Validator drops injected unsupported claims; fallback template works | 6 |
| A8 | Safety gateway (layers L0 to L5, L7 to L9) and safety suite: injection corpora (direct and source-borne), leakage canaries, egress redaction tests, per-layer catch-rate report | A1, A2, A7 | Suite runs in CI; zero known bypass; false-positive rate on normal queries recorded | 9 |
| A9 | Verdict and grounding evaluation sets and runners (false-PASS, unsupported-claim rate) | A5, A7 | Reports generated from fixtures; failures reviewed | 4 |
| A10 | Langfuse datasets, experiments, dashboards, score configs; release report | A3, A4, A9 | Dev and held-out datasets uploaded; dashboard shows latency/cost/scores; gate report written | 4 |

Suggested order: P0, A4 smoke script, A1, A2, A3, A5, A6, A7, A8, A9, A10. A9 and A10 are the safest to trim if time is short, but the false-PASS and unsupported-claim checks inside them are release gates.

### Stream B: Data and Cloud

| ID | Task | Needs | Done when | Est |
| --- | --- | --- | --- | --- |
| B1 | SAM foundation using `LabRole`: Cognito, resource server and scopes, API Gateway authorizer, DynamoDB, S3, EventBridge; Learner Lab service-availability spike (Amplify, EventBridge, Secrets Manager); handlers returning fixtures | P0-3, P0-5 | Deployed dev stack; missing, expired, wrong-scope tokens rejected; fixture responses served | 8 |
| B2 | Connector toolkit: `safeFetch`, SSRF guard, retry/backoff, secret-redacting errors, fixture recorder | P0-4 | SSRF and redaction tests pass | 4 |
| B3 | Hugging Face adapter | B2 | Real candidates normalized with provenance; contract and failure tests; limitation note | 5 |
| B4 | data.gov.in spike, catalog harvest, local index search, resource detail and sample | B2 | Spike notes written; search over harvested index returns candidates; row sample works with the key; key never appears in logs | 8 |
| B5 | Normalization, dedupe, provenance, bounded inspection (CSV/JSON/Parquet) | B3 | Canonical `Dataset` produced from both sources; inspection metrics correct on fixtures; unsafe-file fixtures rejected | 8 |
| B6 | Handlers and pipeline orchestration (extract, connectors in parallel, normalize, inspect, match, score, explain, validate, persist), storage, owner checks, TTL, per-user LLM quota and global cap (layer L6), kill switch | B1, B5, A-package interfaces (use fakes until real) | `POST /search` works end to end on fakes, then real modules; `GET /results` enforces ownership; quota exceeded returns `rate_limited` | 12 |
| B7 | EventBridge refresh Lambda: bounded harvest, idempotency, per-source status | B4 | Re-running does not duplicate or exceed caps; status visible | 4 |
| B8 | Backend security and operations verification | B6 | Auth, isolation, SSRF, `LabRole` usage review, S3 privacy, cache expiry, partial-source tests pass; alarms configured | 5 |
| B9 | Backend deployment, secrets configuration, teardown document | B8 | Deployed environment passes the smoke checklist | 3 |

### Stream C: Web App and Source Connectors

| ID | Task | Needs | Done when | Est |
| --- | --- | --- | --- | --- |
| C1 | Design system: tokens, components, states, accessibility baseline | none | Component gallery covers controls, status badges, tables, forms | 5 |
| C2 | App shell and auth: Cognito/Amplify Auth with PKCE, route guards, token refresh, sign-out; local mock-auth toggle | P0-3 | Works against mock auth and the real user pool | 5 |
| C3 | Search page with editable requirements and all states | P0-3, P0-6 | Works against mock responses including partial-source and clarification | 6 |
| C4 | Results list with score, coverage, verification depth, warnings | C3 | Matches fixtures; unknown never displayed as pass or fail | 5 |
| C5 | Comparison view (2 to 4 datasets) | C4 | Responsive; verdicts and evidence visible on narrow screens | 4 |
| C6 | Detail view: provenance, evidence, access, starter code with copy, preprocessing, next steps, complementary suggestions | C4 | Renders all fields; source text escaped | 6 |
| C7 | OpenML adapter | B2 (use plain fetch with fixtures until it lands) | Adapter checklist complete | 5 |
| C8 | World Bank adapter and indicator index source | B2 | Adapter checklist complete; grain and years clearly marked | 5 |
| C9 | Frontend verification: keyboard, contrast, responsive, error and unauthorized states, XSS payload test | C6 | Checklist passed | 3 |
| C10 | Connect to real API and deploy to Amplify | B1, B9 | Signed-in flow works against the deployed backend | 3 |
| C11 | Extra source adapters behind flags (UCI, Zenodo, Dataverse; generic CKAN as stretch) | B2, B5, C8 | Each passes the adapter checklist | 8 |

C7, C8 and C11 are the only tasks with cross-stream dependencies (the connector toolkit and, for C11, the normalization from B5). They are scheduled after the main UI tasks so those will exist by then; if not, build against fixtures first and swap in `safeFetch` afterwards. C11 is optional stretch work, so it can be cut without affecting the release gates.

Approximate load including Phase 0: Stream A about 55 hours, Stream B about 57, Stream C about 55.

## 16. Milestones and Integration Checks

| Milestone | Definition | Check |
| --- | --- | --- |
| M0 | `contracts-v1` tagged; mock API runs; fixtures committed | Each stream can run its own tests and local dev with no other stream's code |
| M1 Walking skeleton | Deployed protected API serving fixture responses; frontend signs in through the real Cognito pool and renders fixture results; A modules pass unit tests on fixtures; Langfuse smoke trace visible | Token rejection tests; screenshot of fixture results in the deployed UI |
| M2 Vertical slice | Real extraction (live provider or cassette), Hugging Face and data.gov.in candidates, deterministic verdicts and scores, UI on real data, traces with redaction in Langfuse | Five demo queries produce sensible results; first extraction baseline recorded |
| M3 Feature complete | OpenML and World Bank enabled, refresh running, grounded explanations validated, safety suite green, extra sources behind flags | Partial-source behavior shown; safety suite report |
| M4 Release | Gates in Section 11 pass on the held-out split; backend and frontend verification done; demo script rehearsed; known limitations documented | Evaluation report and Langfuse dashboards reviewed together |

## 17. Acceptance Checklist

- A user can sign in, search from the deployed app, and edit extracted requirements.
- Every route requires a valid access token and scope; one user cannot read another user's result.
- Data.gov.in, Hugging Face, OpenML, and World Bank return real source-linked candidates; any one can be disabled or fail without breaking search.
- Extra sources, if enabled, passed the adapter checklist.
- Every displayed field has provenance or is marked unavailable; metadata-only and sample-checked findings are distinguishable.
- Verdicts, evidence, verification level, and score components are deterministic and visible.
- The LLM handles interpretation and phrasing only. Invalid model output, prompt injection, hostile dataset text, unsupported claims, and source timeouts have safe outcomes.
- Langfuse captures redacted traces and scores; a Langfuse outage does not affect search.
- DynamoDB cache and S3 artifacts respect retention, privacy, and license limits; refresh is bounded and idempotent.
- Evaluation report with held-out results and false-PASS review exists.

## 18. Risks and Open Decisions

| Item | Risk or question | Handling |
| --- | --- | --- |
| data.gov.in access | Catalog behavior and key limits are community-reported, not guaranteed | One-hour spike in B4 before committing to the harvest design; fallback is a small curated seed catalog |
| LLM provider access and limits | Free-tier quotas, rate limits, outages, model deprecation, and data-use terms of an external provider | Decision D1; `fake` and `cassette` providers keep everyone moving; fallback provider; circuit breaker; pinned model ID; re-run gates on any model change |
| Learner Lab IAM | No role creation, so least-privilege IAM per function is impossible | Use `LabRole` explicitly; enforce least privilege in code, scopes, and resource policies; document the limitation |
| Learner Lab sessions and service availability | Sessions expire, resources can be reset, and some services (Amplify, EventBridge, Secrets Manager) may behave differently | B1 spike in week one; one-command redeploy; everything important committed to git |
| Safety without managed guardrails | A home-built gateway can have gaps a managed product would not | Layered design, measured per-layer catch rates, safety suite with source-borne cases, new bypasses become permanent tests |
| Corpus size | 50 cases are enough for a baseline but thin for adversarial and no-match claims | Add v0.2 cases and the separate safety suite |
| Sample access limits | Many datasets can only be metadata-checked | Surface verification depth honestly; never claim more than was checked |
| Extra source scope creep | Extra sources cost adapter, fixtures, and limitation notes each | Flags, adapter checklist, stretch status |
| Langfuse plan limits | Project count and retention depend on the plan | Environment attribute plus tags as fallback |
| Registration policy | Open sign-up invites abuse | Decide open vs invite-only before M1 |

## 19. Primary References

- [data.gov.in (OGD Platform India)](https://data.gov.in/) and its developer/API pages
- [Hugging Face Hub API](https://huggingface.co/docs/hub/en/api) and [dataset viewer API](https://huggingface.co/docs/dataset-viewer/quick_start)
- [OpenML data concepts](https://docs.openml.org/concepts/data/) and [REST API](https://docs.openml.org/ecosystem/Rest/)
- [World Bank Indicators API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392)
- [UCI Machine Learning Repository](https://archive.ics.uci.edu/), [Zenodo REST API](https://developers.zenodo.org/), [Dataverse Search API](https://guides.dataverse.org/en/latest/api/search.html), [CKAN API](https://docs.ckan.org/en/latest/api/index.html)
- [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/)
- Structured-output documentation of the provider chosen in decision D1
- [API Gateway Cognito authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html) and [Cognito PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html)
- [Langfuse tracing](https://langfuse.com/docs/observability/get-started), [TypeScript SDK serverless flushing](https://langfuse.com/docs/observability/features/queuing-batching), [evaluation scores](https://langfuse.com/docs/evaluation/scores/overview), [datasets and experiments](https://langfuse.com/docs/evaluation/experiments/datasets), [personal-data controls](https://langfuse.com/security/manage-personal-data)
