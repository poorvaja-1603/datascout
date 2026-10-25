# `@datascout/ai`

This package implements the shared `LlmClient` port from `@datascout/contracts`.
Choose a provider with `LLM_PROVIDER=fake|cassette|gemini|ollama`; callers continue to
use `generateJson(req, ctx)` for every provider.

| Setting                 | Default              | Validation and behavior                                                                        |
| ----------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`          | `fake`               | Must be `fake`, `cassette`, `gemini`, or `ollama`.                                             |
| `LLM_TIMEOUT_MS`        | `30000`              | Integer from 1 to 300000; bounds provider calls. Ollama extraction/explanation use this configured limit to accommodate local inference speed; safety triage and Gemini keep their shorter request-specific caps. |
| `LLM_MAX_OUTPUT_TOKENS` | `1024`               | Integer from 1 to 8192; request output is capped to this value.                                |
| `LLM_CASSETTE_DIR`      | package `cassettes/` | Directory containing deterministic `<request-sha256>.json` replay files.                       |
| `GEMINI_MODEL_ID`       | —                    | Required for Gemini; pin the chosen model ID after checking pricing and terms.                  |
| `GEMINI_API_KEY`        | —                    | Required for Gemini. Server-side secret only; never commit it or expose it to the browser.       |
| `OLLAMA_MODEL_ID`       | —                    | Required for Ollama local inference.                                                            |
| `OLLAMA_BASE_URL`       | `http://127.0.0.1:11434` | Loopback only until authenticated remote Ollama is implemented.                                |
| `LLM_SAFETY_MODEL_ID`   | Main model           | Optional smaller model for L2 safety triage.                                                  |
| `LLM_ENABLED`           | `false`              | Kill switch input for `loadSafetyAdmissionConfig`; hosted services require an enabled gate.    |
| `LLM_MAX_CONCURRENT`    | `4`                  | Per-process concurrency limit.                                                                |
| `LLM_PER_USER_DAILY_LIMIT` | `30`              | Daily principal cap passed to the atomic budget store.                                        |
| `LLM_GLOBAL_DAILY_LIMIT` | `300`               | Daily global cap passed to the atomic budget store.                                            |

Gemini calls use its native JSON response schema; Ollama calls use the native
`/api/chat` JSON-schema format with thinking disabled to reduce latency and
unneeded reasoning tokens for structured extraction. Gemini is the hosted
provider; Ollama is for local development and is not automatically reachable from Lambda. Real Gemini
and Ollama extractors/explainers require a `SafetyAdmission` instance; the API
must provide an atomic daily-budget store and authenticated `principalId`.
Hosted calls are never required for package tests. Cassette files
contain only the structured output, model identifier, and token usage; request
prompts are used only to compute a SHA-256 lookup key and are not logged or
written to the cassette. Provider errors are surfaced as safe `DataScoutError`
values with contract-defined retryability.

## Requirement extraction

`createRequirementExtractor(client, safetyCheck)` provides the versioned
`extract-v1` prompt in `prompts/extract.v1.md`, strict
`ExtractedRequirementsSchema` validation, numeric year-range normalization,
and deterministic `Requirement[]` derivation. It retains UTF-16 offsets into
the original query for exact matches (and the original wording of normalized
year ranges); unmatched or inferred values have `source_span: null`.
Preferences are marked preferred; other derived requirements are required.
No aliases are synthesized.

The built-in deterministic safety gateway runs before any model call: it rejects
malformed/invisible input and long encoded blobs, screens clear prompt overrides
and unsafe requests, and records its outcome in the trace. A caller-supplied
`safetyCheck` can add a project-specific policy. Hosted Gemini/Ollama requests
also receive a schema-constrained safety triage call. Set `LLM_SAFETY_MODEL_ID`
to use a separate smaller model; otherwise triage uses the selected model and
adds one model call per query. Fake and cassette providers skip model triage.
Hosted-provider extractors and explainers require a `SafetyAdmission`, which
applies the kill switch, per-process concurrency limit, and an atomic
daily-budget store contract. The store must atomically
reserve `callCount` against user and global caps. Extraction reserves three
calls (triage plus an extraction retry); explanations reserve one per item.
`createInMemorySafetyBudgetStore()` is for local development/tests only; it
cannot enforce limits across Lambda instances. Production must inject a
DynamoDB-backed atomic store.
Extracted fields are checked
against normalized query tokens and a small explicit alias list; unsupported
fields are removed and counted. These checks are defense in depth, not a
semantic safety guarantee. A null topic produces the contract's fixed
clarification question. Invalid
model output is retried once and then fails with a safe `extraction_failed`
error; timeouts receive one retry and caller cancellation/deadlines are passed
through the existing `CallContext`.

Development-corpus cassette tests are derived only from the 40 annotated
development cases. They are schema/normalization fixtures, not recorded model
predictions or evidence of extraction accuracy. Held-out cases must not be
copied into prompts, fixtures, or tuning.

## Grounded explanations

`createExplanationService(client)` sends bounded, delimited result facts to
the `explain-v1` prompt. The model may return short claims only; deterministic
generic next-step and preprocessing guidance is marked with the
`General guidance:` prefix. The validator rejects malformed output, missing or
cross-dataset evidence IDs, ungrounded words/entities/numbers/URLs, verdict
assertions, guarantees, code instructions, and prompt-leak patterns. Invalid
or fully rejected output returns a deterministic evidence-cited fallback with
`status: unavailable`. Provider and cancellation failures remain explicit
`DataScoutError`s.

The validator is intentionally conservative and does not prove semantic
entailment for every possible sentence. It is a defense-in-depth output gate;
the labeled grounding evaluation and held-out release gate remain necessary
before making quality claims.
