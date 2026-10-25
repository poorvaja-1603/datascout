# DataScout MVP Product Requirements

## Product Goal

DataScout helps students, researchers, and developers find public datasets that fit a data science or machine-learning project. A user describes the need in natural language; the product searches multiple sources and returns ranked candidates with requirement-level evidence, validation notes, access guidance, starter code, and next steps.

The product differentiator is transparent verification. The configured LLM provider interprets the request and can phrase evidence-based guidance. Deterministic application logic validates dataset evidence, assigns requirement verdicts, and calculates suitability scores.

## MVP Users and Workflow

1. Sign up/sign in through Cognito and verify the email address.
2. Enter a project description, such as a crop-yield prediction dataset for Maharashtra with rainfall and temperature fields.
3. Review/edit extracted criteria: topic, geography, time coverage, minimum records, required features, target, preferences, and constraints.
4. Search supported public dataset catalogs.
5. Review ranked results, PASS/PARTIAL/FAIL verdicts, evidence, score breakdown, verification depth, source warnings, and missing metadata.
6. Compare two to four candidates.
7. Open a dataset for source/license/access details, API/download instructions, starter code, quality checks, preprocessing, and project-specific next steps.
8. When no single dataset covers the need, see complementary dataset suggestions and possible join keys, clearly labeled for manual verification.

## Dataset Sources

- Required: data.gov.in and Hugging Face Datasets.
- Additional: OpenML and World Bank Indicators API. World Bank is for structured development indicator time series, not a general ML dataset catalog.
- Each source uses an independent adapter and can be disabled/fail without blocking other sources.
- Search and sample retrieval are bounded. Respect source terms, access restrictions, licenses, rate limits, and attribution.

## Verification and Ranking

- Normalize metadata and retain field provenance.
- Label verification as metadata-only, sample-checked, or full-dataset where justified.
- Check available schema/features, record count, geography/time coverage, access, and basic sample quality when allowed.
- Evaluate every criterion as PASS, PARTIAL, or FAIL. Missing evidence is internally UNKNOWN and displayed as PARTIAL/not verified; it must never be treated as confirmation.
- Calculate a deterministic 0-100 score with visible components for requirement match, validation/access, metadata completeness, license/source clarity, and freshness. Missing evidence earns no points and lowers evidence coverage.
- Every factual explanation must point to retrieved evidence. The model must not determine verdicts or scores.

## UI Direction

Use the **Brutalist x Tactile** visual direction: strong typography, crisp borders, restrained offset shadows and clear pressed/selected states, with an ink/light foundation and limited vivid accents. Keep result data, evidence, score breakdowns, and validation notes high-contrast and easy to scan. Preserve keyboard access, readable contrast, responsive comparisons, and text labels alongside status colors.

## AWS and Observability

- AWS Amplify: host the React application.
- Amazon API Gateway: REST API entry point and API protection controls.
- Amazon Cognito: verified user sign-up/sign-in and access token issuer for API authorization.
- AWS Lambda: API orchestration, source adapters, validation/scoring, and scheduled refresh.
- Fake/cassette LLM provider: requirement extraction and evidence-grounded explanations/guidance.
- Amazon DynamoDB: normalized dataset details and search-result cache.
- Amazon S3: private metadata snapshots and permitted bounded samples/artifacts.
- Amazon EventBridge: bounded, idempotent catalog refresh trigger.
- Langfuse: external LLM tracing and evaluation; redact/minimize data before export. Langfuse failure must not fail search.

## Safety, Privacy, and Quality

- Treat user prompts and all retrieved dataset text/rows as untrusted data; resist prompt injection and never execute source-provided code.
- Enforce strict JSON schemas for model output and validate generated claims against evidence IDs before display.
- Restrict fetches to approved source hosts, block private/link-local targets and unsafe redirects, and apply time/size/row/content-type limits.
- Never expose API keys, Langfuse credentials, prompts, or internal errors in the frontend. Redact sensitive values from traces.
- Use Cognito Authorization Code with PKCE for the React public client; no browser client secret. Require verified users, least-privilege API scopes, and owner checks on per-user search results.
- Test extraction quality, retrieval coverage, verdict accuracy/false-PASS rate, scoring determinism, evidence support, injection/secret-leakage cases, source failures, latency, and trace delivery.

## Required API

Every route requires a valid Cognito access token in the Authorization bearer header and the matching scope:

- `POST /search` - `datascout-api/search`
- `GET /results/{request_id}` - `datascout-api/read`; only the owner may retrieve the cached result.
- `POST /compare` - `datascout-api/compare`
- `GET /dataset/{dataset_id}` - `datascout-api/read`

## MVP Acceptance

- A deployed React user can search and inspect editable requirements.
- Users can sign in through Cognito; API Gateway rejects missing, expired, invalid, or under-scoped tokens. Users cannot read another user's search result.
- Four source adapters can return normalized, source-linked candidates; source failure is visible and partial.
- Results and comparison show evidence, verification depth, score components, and uncertainty honestly.
- Details include usable access guidance and source-appropriate starter code when available.
- EventBridge refresh, DynamoDB cache/details, private S3 storage, and Langfuse trace/evaluation are configured.
- Safety and offline evaluation gates in [`plan.md`](plan.md) pass before demo/release.

## Out of Scope

Admin dashboards/roles, paid/private catalogs, hosting full datasets, model training, arbitrary crawling, executing dataset code, production-scale exhaustive ingestion, vector search, and automated joins.
