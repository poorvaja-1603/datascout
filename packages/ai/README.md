# `@datascout/ai`

This package implements the shared `LlmClient` port from `@datascout/contracts`.
Choose a provider with `LLM_PROVIDER=fake|cassette`; callers continue to
use `generateJson(req, ctx)` for every provider.

| Setting                 | Default              | Validation and behavior                                                                        |
| ----------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`          | `fake`               | Must be `fake` or `cassette`.                                                                  |
| `LLM_TIMEOUT_MS`        | `30000`              | Integer from 1 to 300000; the smaller request or config timeout and the context deadline wins. |
| `LLM_MAX_OUTPUT_TOKENS` | `1024`               | Integer from 1 to 8192; request output is capped to this value.                                |
| `LLM_CASSETTE_DIR`      | package `cassettes/` | Directory containing deterministic `<request-sha256>.json` replay files.                       |
Cloud model calls are not part of this configuration. Cassette files
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

The required `safetyCheck` runs before any model call and returns a contract
refusal reason, a `{ sanitizedQuery }` for a detected hostile suffix, or
`null`. The backend supplies `createRequestSafetyCheck()` as a deterministic
first-pass screen; it is a heuristic and needs broader adversarial evaluation
before release. A null topic produces the contract's fixed clarification question. Invalid
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
