# DataScout MVP Development Plan

## 1. Product Outcome

Deliver an end-to-end web app where a user describes a data science or ML project and receives ranked public datasets with requirement-by-requirement evidence, deterministic suitability scores, validation notes, source/API access instructions, starter code, preprocessing guidance, and next steps.

DataScout's core promise is verification, not merely semantic search:

- The LLM interprets natural language and writes concise explanations grounded in retrieved evidence.
- Source connectors retrieve real catalog metadata and, when permitted and practical, a small data sample.
- Deterministic code validates metadata/data, assigns PASS/PARTIAL/FAIL, and calculates the score.
- The response validator removes or marks claims that do not have evidence.

The MVP supports data.gov.in and Hugging Face first. Add OpenML and World Bank indicators through the same connector contract after the core flow is stable. World Bank is a focused source for country/time-series development indicators, not a general-purpose dataset catalog.

## 2. MVP Scope and Release Boundary

### In scope

- React app hosted on AWS Amplify.
- REST API through API Gateway and TypeScript Lambda functions.
- Amazon Cognito User Pool for user sign-up/sign-in and API Gateway Cognito authorizer for authenticated, scope-based API access.
- Bedrock requirement extraction and evidence-grounded explanation/guidance generation.
- Connectors for data.gov.in, Hugging Face, OpenML, and World Bank Indicators API.
- Common metadata schema, bounded dataset inspection, deterministic matching/scoring, candidate comparison, and cache.
- DynamoDB for normalized metadata and search results; private S3 for raw metadata snapshots and permitted, size-limited samples/artifacts.
- EventBridge-triggered, bounded catalog refresh.
- Langfuse tracing and evaluation for LLM spans and end-to-end requests.
- Unit/integration tests and a curated offline evaluation set.

### Out of scope

- Private/paid sources, dataset hosting, model training, arbitrary web crawling, running source-provided code, admin dashboards/roles, and exhaustive copies of every upstream catalog.
- Production-scale ingestion, full-dataset quality profiling, semantic vector search, and automated dataset joins. The MVP may suggest join candidates using matching keys and metadata, but must label them as suggestions requiring verification.

## 3. User Workflow

1. User signs up/signs in through Cognito from the React app; the app obtains an access token using Authorization Code with PKCE.
2. The app calls API Gateway with the bearer access token. API Gateway validates the Cognito token and route scope before invoking Lambda.
3. User submits a project description and optional constraints.
4. API validates input size and request shape; assign a request ID and associate it with the authenticated Cognito `sub`.
5. Bedrock returns a strict `ExtractedRequirements` object. Validate it against a schema and normalize units, aliases, and empty/unknown fields. If extraction fails, return a clear retry/clarification response; do not search on malformed criteria.
6. Query enabled source adapters in parallel with per-source timeouts, result limits, and rate-limit handling.
7. Normalize results into the shared dataset schema and retain source provenance for each field.
8. Store raw metadata snapshots in S3 where permitted; inspect only public, supported, bounded samples.
9. Run deterministic metadata/data checks and requirement matching. Each verdict includes evidence, verification depth, and a reason.
10. Calculate a reproducible 0-100 score, sort candidates, and flag missing/unknown evidence.
11. Optionally ask Bedrock to phrase explanations and usage guidance using only the verified result objects. Validate every generated claim against evidence before returning it.
12. Persist the response/cache in DynamoDB and return ranked results to the UI.
13. User compares candidates and opens details for source links, license/access notes, validation, starter code, preprocessing steps, and next actions.
14. EventBridge invokes a refresh Lambda on a schedule to update a bounded set of catalog/search metadata; it must not silently crawl or download entire upstream catalogs.

## 4. Architecture and Responsibilities

```text
React / Amplify Auth <-> Cognito User Pool
      | access token (Bearer)
API Gateway Cognito authorizer -> Search Lambda -> Bedrock requirement extraction
                    |          -> source adapters
                    |          -> normalize -> sample/metadata validation
                    |          -> deterministic matching and score
                    |          -> grounded explanation + response validator
                    |          -> DynamoDB results/dataset cache; S3 snapshots/samples
                    +----------> Langfuse traces and evaluation scores

EventBridge -> Refresh Lambda -> source adapters -> DynamoDB / S3
```

Use the AWS services named in the abstract/PRD: Amplify, API Gateway, Lambda, Bedrock, DynamoDB, S3, and EventBridge. Add Amazon Cognito because API authentication/authorization is now required by the team and is also shown in the architecture deck. Use a Cognito User Pool and API Gateway REST API Cognito authorizer. Langfuse is the external LLM observability/evaluation platform; use its hosted service for the MVP unless the team separately chooses and operates a self-hosted deployment. Do not add other AWS services to the baseline without recording the reason and cost in a decision note.

### Authentication and authorization contract

- Use a Cognito User Pool for end-user registration, email verification, sign-in, token refresh, and sign-out. Use a public SPA app client with no client secret and OAuth Authorization Code grant with PKCE.
- Define a Cognito resource server `datascout-api` with custom scopes `search`, `read`, and `compare`. API Gateway REST API methods use the Cognito User Pool authorizer and require the matching access-token scope: `POST /search` -> `datascout-api/search`; `GET /results/{request_id}` and `GET /dataset/{dataset_id}` -> `datascout-api/read`; `POST /compare` -> `datascout-api/compare`.
- Require an access token in the `Authorization: Bearer <token>` header for every user-facing route. Do not use API keys as user authentication. Keep EventBridge refresh invocation on its separate AWS service permission path, not the public API.
- Lambda obtains the verified `sub` claim from API Gateway authorizer context. Store it as `owner_sub` on each search request/result. `GET /results/{request_id}` must check ownership and return 404 for another user's request. Public dataset metadata/details may be shared among authenticated users; compare accepts only known public dataset IDs.
- MVP roles: all verified users have the same search/read/compare capabilities; no admin endpoints or role management. Restrict sign-up to verified email addresses and document whether registration is open or invite-only for the demo.
- Restrict CORS to the deployed Amplify origin(s); permit only required headers/methods. API Gateway throttling and input validation complement authentication but do not replace it.
- Frontend uses Cognito/Amplify Auth token handling; do not place a client secret in the browser or implement token parsing/refresh by hand.

### Backend modules

- `handlers`: route and scheduled refresh entry points; validate requests and map errors to stable API responses.
- `services/requirements`: Bedrock prompt, strict JSON parsing, schema validation, normalization, fallback/error behavior.
- `connectors`: one adapter per upstream source; source-specific parsing stays out of scoring/UI code.
- `services/normalization`: map source fields to the canonical schema and attach provenance/verification depth.
- `services/inspection`: safe metadata and bounded sample checks; never execute dataset code.
- `services/matching`: deterministic field/alias matching and requirement verdicts.
- `services/scoring`: versioned, deterministic score components and explanation breakdown.
- `services/response-validation`: validate generated explanations/guidance against facts and evidence IDs.
- `storage`: DynamoDB query/result persistence and S3 snapshot/sample access.
- `observability`: Langfuse trace/span creation, redaction, trace flush, and evaluation score reporting.

## 5. Source Plan

### Source tiers

| Tier     | Source                    | MVP use                                                                                                                      | Important boundary                                                                                                                             |
| -------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Required | data.gov.in               | Search Indian government catalog/resources; collect catalog/API metadata and query resource APIs when available              | A resource may require an API key and may expose only partial metadata. Record access failures and key configuration without exposing secrets. |
| Required | Hugging Face Datasets     | Search public dataset repositories; read card metadata, tags, files, license, and supported viewer/parquet metadata          | Public listing does not imply data is ungated, safe to download, or licensed for every use. Never execute repository code.                     |
| Added    | OpenML                    | Search ML datasets and use its dataset metadata/IDs; retrieve a sample only through supported APIs                           | Treat license/status and row/feature metadata as source claims until checked. Do not upload data.                                              |
| Added    | World Bank Indicators API | Search/retrieve indicator definitions and country/time-series observations for requirements involving development indicators | A structured indicator series may not meet a request for row-level ML data. Mark grain, geography, years, and definition clearly.              |

Implement OpenML and World Bank as adapters behind the normalized interface, after a vertical slice for data.gov.in + Hugging Face. Each additional adapter needs a contract test, one saved fixture, timeout/rate-limit behavior, provenance mapping, and a source-specific limitation note before it is enabled in the UI.

### Adapter contract

Each connector should expose:

```ts
search(requirements, options): Promise<ConnectorResult[]>
getDetails(datasetId): Promise<ConnectorResult | null>
inspectSample?(dataset, limits): Promise<SampleInspection>
```

Return stable internal fields: `dataset_id`, `source`, `source_url`, `title`, `description`, `license`, `access_type`, `api_endpoint`, `file_formats`, `record_count`, `columns/features`, `geography`, `time_coverage`, `tags`, `last_updated`, `retrieved_at`, `raw_snapshot_key`, and per-field provenance. Missing fields stay `unknown`/null; do not infer them from a title as if verified.

### Connector behavior

- Search a bounded top-N per source with query length, page count, concurrency, timeout, and response-byte limits.
- Add retry with backoff only for transient errors; respect 429/Retry-After and source terms.
- Make source failures partial: return results from healthy adapters with a visible source status/warning.
- De-duplicate by canonical source ID/URL, not title alone.
- Store a retrieval timestamp and source version/etag where available; cache with TTL and invalidate stale entries on refresh.
- Keep API keys and Langfuse credentials out of source code, frontend bundles, logs, and committed files.

## 6. Verification, Matching, and Scoring

### Verification levels

Every result must say how it was checked:

- `metadata_only`: public metadata/card/catalog inspected; no data rows checked.
- `sample_checked`: bounded, permitted sample inspected.
- `full_dataset`: reserve for a source that provides an explicit, safe, small full dataset; do not claim this for large remote datasets.

MVP checks: metadata completeness; required field/feature presence; target presence; stated row count vs requested minimum; geography/time coverage; supported format/access; basic sample missingness, duplicate rows, column types, and date parse/range where sample access is permitted. Metadata-based checks must be labeled as metadata-based, not data quality proof.

### PASS / PARTIAL / FAIL / UNKNOWN

The PRD requires PASS/PARTIAL/FAIL. Internally preserve `UNKNOWN` for unavailable evidence, then render it as `PARTIAL` with an explicit “not verified” reason. Do not convert missing metadata to PASS or FAIL. Define requirement-specific rules before coding:

- PASS: authoritative metadata/sample directly confirms the condition.
- PARTIAL: evidence is ambiguous, indirect, stale, only metadata-level, or a threshold is not verifiable.
- FAIL: verified evidence contradicts the requirement.

Each match carries `requirement_id`, `status`, `reason`, `evidence_ids[]`, `verification_level`, and optional measured value. The UI displays evidence/source and distinguishes “not found” from “not available to verify.”

### Initial deterministic score (version `score-v1`)

Keep a score breakdown and publish the formula in the UI/docs. Use weighted normalized components:

- Requirement satisfaction: 50 points. PASS=1, PARTIAL=0.5, FAIL=0; weight required criteria more than preferences. UNKNOWN contributes zero until verified and is shown as unknown.
- Validation/access: 20 points. Based on supported access and available quality checks; metadata-only results cannot receive sample-quality credit.
- Metadata completeness: 15 points. Fixed list of useful fields present, excluding fields not applicable to that source.
- License/source clarity: 10 points. Reward explicit license/access/source provenance, not assumed “reliability.”
- Freshness: 5 points. Use source `last_updated` when available; otherwise score as unknown/partial rather than treating retrieval time as dataset freshness.

For the MVP, do not renormalize missing/unknown dimensions: an unknown value earns zero points and reduces the displayed evidence coverage. This makes low evidence visible instead of making an incompletely verified candidate look stronger. Include `scoring_version`, component values, weights, and evidence. Unit tests must prove identical inputs yield identical scores. Ranking must not be model-generated.

## 7. LLM Design and Safety

### Model responsibilities

- Extract a typed requirement schema from user text.
- Optionally create short, user-friendly explanations and preprocessing/next-step guidance from validated result/evidence objects.
- Never decide source truth, PASS/PARTIAL/FAIL, row counts, score, license, or API availability.

### Controls

1. Validate input type/length and reject empty or oversized input; constrain output token budget.
2. Use a versioned system prompt and JSON schema. Parse JSON strictly; reject extra fields, wrong enums, invalid numeric bounds, and malformed arrays. No “repair and trust” parsing for critical requirements.
3. Treat user text and all source content (dataset cards, README text, CSV cells, API descriptions) as untrusted data, never instructions. Delimit source evidence; do not let retrieved text change tools, system instructions, or output format.
4. Do not let the model choose arbitrary URLs or tools. Connectors use fixed source hosts; sample fetches enforce host allowlists after redirects, block private/link-local IPs, use timeouts and byte/row limits, and reject unsupported content types.
5. Do not execute notebooks, pickle files, scripts, or source-provided loading code. Parse only explicitly supported data formats with safe libraries and bounded resources.
6. Require every user-facing factual explanation to cite internal evidence IDs. A deterministic validator checks cited IDs exist and each claim maps to retrieved/validated fields. Unsupported claims are removed or replaced with “not verified”; if validation fails, return the deterministic result without generated prose.
7. Use Amazon Bedrock Guardrails for prompt-attack/content checks when enabled. Tag user-controlled prompt sections as required by the selected Bedrock invocation path. Keep application validation in place because Guardrails do not verify dataset facts and do not assess arbitrary connector/tool outputs.
8. Avoid collecting personal data. Redact likely PII from trace inputs/outputs before export; never log credentials, API keys, full raw samples, or signed URLs. Keep snapshots private and store only permitted/necessary data with a defined retention/TTL policy.
9. Add request IDs, rate limits at the app/API boundary, bounded parallelism, and graceful model/source timeout handling. Avoid returning internal prompts, stack traces, credentials, or model chain-of-thought.
10. Record prompt version, model ID, schema version, scorer version, source IDs, and guardrail outcome for reproducibility.

### Langfuse

- Create one trace per API request and spans for requirement extraction, each source adapter, normalization, inspection, scoring, explanation generation, and response validation.
- Capture latency, token usage when available, model/prompt version, source status/counts, score version, and validation outcomes.
- Use a deterministic correlation ID (request ID) without putting user identity or secrets in metadata.
- Redact before events leave Lambda. Make raw prompt/response capture opt-in for development; production traces should prefer masked/minimized fields. Set retention to the shortest useful period and separate dev/prod environments.
- Flush trace events before Lambda exits; use Langfuse's supported current SDK/API and test asynchronous flush under Lambda timeouts.
- Attach programmatic evaluation scores to traces: extraction schema validity, requirement extraction correctness, evidence coverage, unsupported-claim check, source success, and response completeness. Use human review for a sample of explanations; LLM-as-judge may assist triage but is not the sole release gate.
- Keep Langfuse optional at runtime: observability failure must not fail dataset search. Emit a safe operational log/metric if trace delivery fails.

## 8. Evaluation Plan and MVP Gates

Build a versioned, manually reviewed evaluation set before tuning prompts. Start with at least 50 requests: varied domains, geography/time/size constraints, multiple requirements, ambiguous requests, no-match requests, source-specific wording, typos/synonyms, and adversarial prompt-injection examples. Include expected structured requirements and source/result evidence where feasible. Keep a held-out subset for final checks.

### Offline measures

- Extraction: schema-valid rate; per-field precision/recall/F1 for topic, geography, time, min rows, attributes, target, constraints; numeric/unit exactness.
- Retrieval: Recall@5/10 for known relevant datasets, source coverage, duplicate rate, and per-source success/error rate.
- Verification: verdict accuracy against human-labeled evidence; false-PASS rate separately; unknown handling accuracy.
- Scoring: determinism, monotonicity (adding verified required matches must not reduce score), component correctness, ranking agreement with a human-reviewed rubric.
- Grounding: evidence-ID validity, supported-claim rate, unsupported-claim rate, and factual error review on generated prose.
- Safety: prompt injection success, secret/prompt leakage, arbitrary URL/SSRF attempt handling, unsafe file/code execution attempts, PII leakage in traces, and guardrail false positives.
- Operations: p50/p95 latency, per-source timeout/rate-limit behavior, Bedrock failure behavior, cache hit rate, trace delivery success, and estimated cost per search.

### Initial release gates (calibrate on the reviewed set)

- 100% API responses conform to the response schema; malformed model output is rejected or safely falls back.
- 100% PASS verdicts include evidence IDs and a supported verification level.
- Zero known unsupported factual claims in the held-out set; zero known secret leakage or executed external code in safety cases.
- False-PASS rate is zero on the MVP acceptance set; ambiguous evidence must map to PARTIAL/UNKNOWN.
- Score is deterministic across repeated fixture runs; threshold changes require a scorer version bump.
- Each required source has a successful contract test and graceful failure test. Extra sources can be disabled independently.
- Search works when any one external source is unavailable and clearly indicates partial coverage.
- Langfuse failure does not fail the product request; redaction checks pass before trace data leaves the application.

Review gate failures with labeled examples. Do not optimize only for aggregate scores: false PASS, unsupported claims, and safety failures are release blockers.

## 9. API and Data Contracts

### REST endpoints

- `POST /search` (scope `datascout-api/search`) - `{ "query": "...", "options": { "sources": ["data.gov.in", "huggingface"] } }`; default to enabled sources. Return `request_id`, normalized requirements, source statuses, ranked results, score breakdown, evidence, and warnings. Save the authenticated user's `sub` as owner.
- `GET /results/{request_id}` (scope `datascout-api/read`) - retrieve cached search response only when owned by the authenticated user.
- `GET /dataset/{dataset_id}` (scope `datascout-api/read`) - return normalized public detail, provenance, validation, access instructions, code sample, preprocessing, and next steps.
- `POST /compare` (scope `datascout-api/compare`) - `{ "dataset_ids": ["..."] }`; return side-by-side normalized fields and evidence, not an LLM-authored winner.

All four routes require a valid Cognito access token and the route's custom scope. API Gateway rejects missing, expired, invalid, or under-scoped tokens before Lambda runs.

Use stable error objects (`code`, safe `message`, `request_id`, optional `retryable`). Validate IDs and body sizes. Add pagination/limits before allowing arbitrary result counts.

### Core records

- `Requirement`: ID, type, value, unit, required/preferred, normalized aliases, confidence, extraction evidence/source text span.
- `Dataset`: canonical source ID, source, URL, normalized metadata, field provenance, retrieved/updated timestamps, license/access, verification level, snapshot key.
- `RequirementMatch`: requirement ID, verdict, reason, evidence IDs, measured value, verification level.
- `SearchResult`: request ID, dataset ID, score + component breakdown, match array, quality results, warnings, explanation, version fields.

Use separate DynamoDB item keys/access patterns for request cache and dataset detail. Store `owner_sub` on request/result records and enforce it on reads; never rely on an unguessable request ID as authorization. Set TTL on cached results; do not let expired cache entries be treated as current source data. Keep S3 private; use stable source/request-scoped prefixes and lifecycle/retention rules. Store only samples needed for reproducibility and only where source license/terms permit.

## 10. Frontend Work

### Visual direction: Brutalist x Tactile

Use Option C as the product direction: bold, high-contrast structure from neo-brutalism, softened by tactile interaction details. DataScout should feel distinctive and hands-on while keeping dataset evidence easy to scan and trust.

- Use a compact operational layout: strong typographic hierarchy, clear alignment, visible section dividers, and purposeful asymmetry only in the search/intro area.
- Use an ink-and-light neutral foundation with a small set of vivid accents, such as cobalt and acid-lime. Reserve green, amber, and red for PASS, PARTIAL, and FAIL; never use color as the only status signal.
- Use crisp borders and restrained offset shadows on primary controls, selected filters, and active result rows. Give buttons, toggles, tabs, and comparison selection clear pressed/selected states.
- Keep surfaces mostly flat. Use small framed result rows where they help comparison; do not put cards inside cards or turn every section into a floating panel.
- Apply tactile styling to controls and transitions, not to evidence itself. Tables, field names, source links, score breakdowns, and validation notes should remain plain, high-contrast, and consistently aligned.
- Keep headings expressive but compact. Use stable type sizes rather than viewport-scaled text; keep body text and data labels optimized for repeated scanning.
- Use familiar icons for search, compare, source links, copy code, and navigation, with accessible names/tooltips for icon-only controls.
- Preserve keyboard focus, visible hover/focus/pressed states, readable contrast, and responsive layouts. On narrow screens, stack comparison fields without hiding verdicts or evidence.
- Avoid heavy textures, noisy backgrounds, oversized display type on data screens, and decorative motion that competes with results.

- Search page with example query, clear loading/error/empty/partial-source states, and editable extracted requirements.
- Sign-up/sign-in, email verification, signed-in state, token refresh, and sign-out through Cognito/Amplify Auth; show clear unauthorized/session-expired states.
- Results list/table with title, source, score, score coverage, verification depth, verdict summary, and source warnings.
- Comparison view for 2-4 datasets: criterion verdicts, evidence, data grain, access, license, and quality checks.
- Detail view with source link, metadata/provenance, validation evidence, API/download instructions, runnable starter code where source permits, preprocessing checklist, and next steps.
- Make uncertainty visible: unknown/missing metadata must not look like a verified failure or success.
- Keep generated explanation secondary to deterministic evidence and support direct source navigation.

## 11. AWS and Deployment Plan

1. Confirm AWS region, Bedrock model availability/access, data.gov.in credentials, Langfuse environment, budget limits, Cognito registration policy, and redirect/logout URLs.
2. Define SAM resources and IAM least privilege, including the Cognito User Pool, public SPA app client, resource server/scopes, API Gateway Cognito authorizer, and per-route scope configuration. API Lambda needs only required table/bucket operations and Bedrock invocation; refresh Lambda needs connector and snapshot permissions. Avoid wildcard resource permissions where ARNs are available.
3. Create DynamoDB tables with on-demand billing for MVP, indexes only for documented access patterns, `owner_sub` on user search records, and TTL for search cache.
4. Create a private S3 bucket with block-public-access, encryption, lifecycle/retention policy, and no public sample hosting.
5. Configure Cognito Authorization Code + PKCE, verified-email policy, allowed callback/logout URLs, and token lifetimes. Configure API Gateway Cognito authorizer on every user route with custom scopes; configure CORS to the Amplify origin, request validation, throttling, and Lambda error handling. Never expose client secrets, source keys, or Langfuse secrets to Amplify frontend variables.
6. Configure EventBridge schedule for bounded refresh; record per-source last success, failures, and item counts. Refresh should be idempotent and use its own service invocation permission.
7. Deploy frontend to Amplify with API URL and public Cognito identifiers only. Configure environment-specific API, callback, and logout URLs.
8. Add alarms/log review procedures for Lambda errors/timeouts/throttling, Bedrock failures, source failures, auth failures, and storage growth. Avoid logging request bodies or tokens by default.
9. Document teardown and rotate credentials after demo if any secrets were shared.

## 12. Numbered Build Sequence and Team Tasks

The sequence is numbered by implementation order. Each number has one owner; the task-number lists below do not overlap.

1. **Freeze backend/data contracts.** Define API routes, request/response schemas, Cognito scopes and ownership field, canonical dataset metadata, evidence format, verification labels, scoring version, supported sample formats, source identifiers, and retention limits. **Owner: Teammate 3.** **Deliverable:** versioned backend/data contracts.

2. **Set up AWS foundation and API protection.** Create the SAM project, Cognito User Pool/public SPA app client/resource-server scopes, API Gateway Cognito authorizer, Lambda routes, DynamoDB tables with `owner_sub`, private S3 bucket, and EventBridge schedule. Require scopes on every user-facing route. **Owner: Teammate 3.** **Deliverable:** deployable protected API skeleton and environments.

3. **Prepare LLM evaluation and observability.** Create the curated extraction/evidence evaluation set, label expected requirements, configure Langfuse environments and redaction rules, and record baseline metrics. **Owner: Teammate 1.** **Deliverable:** versioned evaluation dataset and usable Langfuse project.

4. **Build the required source adapters.** Implement data.gov.in and Hugging Face search/detail adapters, source-specific error handling, canonical normalization, field provenance, and connector fixtures. **Owner: Teammate 3.** **Deliverable:** real candidate metadata from both required sources.

5. **Implement Bedrock requirement extraction.** Add a versioned prompt, strict schema parsing, normalization, malformed-output handling, and safe clarification/failure behavior. Treat user text as untrusted. Evaluate extraction against Step 3 and instrument the call in Langfuse. **Owner: Teammate 1.** **Deliverable:** validated requirements object and measured extraction baseline.

6. **Implement deterministic verification and ranking.** Add bounded safe sample inspection, metadata/data quality checks, evidence-backed PASS/PARTIAL/FAIL, UNKNOWN handling, versioned score breakdown, and source-level partial-result behavior. **Owner: Teammate 1.** **Deliverable:** reproducible ranked results with evidence and verification depth.

7. **Build the frontend experience.** Create the Brutalist x Tactile design system and responsive sign-up/sign-in, search, editable requirements, ranked results, comparison, and detail views. Show source warnings, score coverage, evidence, and uncertainty clearly. **Owner: Teammate 2.** **Deliverable:** complete UI flows against the agreed API types.

8. **Connect frontend auth and API.** Integrate Cognito/Amplify Auth with Authorization Code + PKCE, send scoped bearer access tokens, handle expired/unauthorized states, and connect search/results/compare/detail calls. **Owner: Teammate 2.** **Deliverable:** signed-in end-to-end flow for required sources.

9. **Add extra sources and scheduled refresh.** Implement OpenML and World Bank Indicators adapters behind source flags, document their limits, and add bounded/idempotent EventBridge refresh with S3 snapshots and DynamoDB updates. **Owner: Teammate 3.** **Deliverable:** four independently switchable sources and observable refresh.

10. **Add grounded explanations and LLM safety.** Generate optional explanations/access/preprocessing guidance only from validated result objects. Require evidence IDs, run the response validator, add prompt-injection/leakage cases and Bedrock Guardrails where configured, and trace stages with redaction in Langfuse. **Owner: Teammate 1.** **Deliverable:** grounded, validated LLM output with safety/evaluation scores.

11. **Verify backend security and operations.** Check Cognito token/scope rejection, cross-user result isolation, source limits/timeouts, IAM, S3 privacy, cache expiry, EventBridge idempotency, and partial-source behavior. **Owner: Teammate 3.** **Deliverable:** backend/security acceptance results.

12. **Verify frontend workflows.** Check sign-up/sign-in, API authorization errors, responsive search/results/compare/details, keyboard access, evidence visibility, and uncertainty states. **Owner: Teammate 2.** **Deliverable:** frontend acceptance results.

13. **Run LLM quality and safety evaluation.** Measure extraction accuracy, false-PASS and unsupported-claim rates, prompt-injection/leakage cases, groundedness, latency, and cost. Review failures and update prompts/evaluators before release. **Owner: Teammate 1.** **Deliverable:** evaluation report and release-gate scores.

14. **Deploy the backend and scheduled refresh.** Deploy API Gateway, Cognito settings, Lambda functions, DynamoDB, S3, and EventBridge; verify environment variables, secrets, scopes, and callback/logout URLs. **Owner: Teammate 3.** **Deliverable:** deployed backend environment.

15. **Deploy the frontend.** Configure Amplify with the API endpoint and public Cognito identifiers, set callback/logout URLs, and verify the signed-in app flow against the deployed backend. **Owner: Teammate 2.** **Deliverable:** deployed frontend.

16. **Finalize LLM monitoring and demo readiness.** Confirm Langfuse traces/scores arrive with redaction, dashboards show quality/safety/latency/cost, and the demo queries have expected evaluation results. Document known limitations. **Owner: Teammate 1.** **Deliverable:** monitoring-ready, demo-ready LLM pipeline.

### Task numbers by teammate

- **Teammate 1 (pooh-dev):** 3, 5, 6, 10, 13, 16
- **Teammate 2 (frontend and API integration):** 7, 8, 12, 15
- **Teammate 3 (connectors, scoring, and AWS):** 1, 2, 4, 6, 9, 11, 14

## 13. Acceptance Checklist

- A user can search from the deployed React app and see extracted/editable requirements.
- Users can sign up/sign in through Cognito; every user-facing API route requires a valid access token and its required scope.
- A signed-in user cannot retrieve another user's cached search result by supplying its request ID.
- The UI follows the Brutalist x Tactile direction while preserving readable, accessible, evidence-first results.
- Data.gov.in and Hugging Face return real source-linked candidates; OpenML and World Bank are enabled as the added source adapters.
- Candidate records are normalized and every displayed field has provenance or is clearly marked unavailable.
- Results show requirement verdicts, evidence, verification level, deterministic score and component breakdown.
- Comparison and details work; access guidance/code is source-specific and does not invent credentials or endpoints.
- The UI distinguishes metadata-only from sample-checked findings and shows partial source failures.
- Bedrock handles interpretation/explanation only; scorer and verdicts are deterministic.
- Invalid model output, prompt injection, untrusted dataset-card instructions, unsupported claims, and source timeouts have safe outcomes.
- Langfuse captures redacted traces/scores; Langfuse outage does not break search.
- DynamoDB cache and S3 snapshots/samples follow retention, privacy, and licensing constraints.
- EventBridge refresh is bounded, idempotent, observable, and does not download whole catalogs.
- Offline evaluation and release gates are documented with held-out examples and false-PASS review.

## 14. Useful Primary References

- [data.gov.in catalog and API](https://data.gov.in/)
- [Hugging Face Hub API](https://huggingface.co/docs/hub/en/api) and [dataset viewer API](https://huggingface.co/docs/dataset-viewer/quick_start)
- [OpenML data concepts](https://docs.openml.org/concepts/data/) and [REST API](https://docs.openml.org/ecosystem/Rest/)
- [World Bank Indicators API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392)
- [Amazon Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html) and [prompt-attack detection](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-prompt-attack.html)
- [Amazon API Gateway Cognito User Pool authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html) and [Cognito Authorization Code with PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html)
- [Langfuse tracing](https://langfuse.com/docs/observability/get-started), [evaluation scores](https://langfuse.com/docs/evaluation/scores/overview), [datasets/experiments](https://langfuse.com/docs/evaluation/experiments/datasets), and [personal-data controls](https://langfuse.com/security/manage-personal-data)
