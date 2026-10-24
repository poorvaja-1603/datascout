# DataScout LLM evaluation (provisional v0.1)

This is the reviewed v0.1 extraction corpus, confirmed by the project owner on 2026-10-24. Its eight expected fields match the `ExtractedRequirements` schema in `contracts/`. Keep held-out examples reserved for final evaluation.

## Corpus

`requirements-v0.1.jsonl` contains 50 natural-language requests: 40 development cases and 10 held-out cases. Coverage includes domains, geography, time, minimum size, multiple requirements, ambiguous and underspecified requests, impossible or inappropriate requests, source-specific wording, synonyms/typos, and prompt-injection attempts. Gold values only capture explicit information in a request; absent requirements are null/empty, not inferred.

Each non-null/non-empty gold field has one or more exact evidence snippets in `evidence`. These are user-request spans for extraction evaluation, not dataset-source evidence. Source-backed retrieval/verdict labels are intentionally absent because no source adapters, retrieved fixtures, or evidence contract exist yet. Do not score dataset verification, false-PASS, or groundedness from this corpus.

For consistent provisional labels, normalize numeric year ranges in `time_coverage` to `YYYY-YYYY` (for example, `2018-2023`), while keeping the original wording in `evidence`. Preserve non-range expressions such as `next year` or `summer 2019` until the frozen backend contract defines their normalization.

`held_out` cases are reserved for final evaluation. Do not tune prompts or rules against them. Split membership is part of the versioned dataset.

## Validate corpus structure

Run with Python 3 and no third-party dependencies:

```powershell
python evals\validate_dataset.py
```

This checks JSONL parsing, IDs, split counts, category coverage, field types, and that annotated evidence snippets occur in their input. Passing validation only establishes corpus integrity; it does not establish annotation correctness or model quality.

## Extraction runner (structural replay only)

Run from the repository root:

```powershell
npx tsx evals\runner.ts
```

The default is the A2 cassette provider and **development cases only**. A report
is written under `evals/reports/` and contains the full-corpus SHA-256, timestamp,
selected split, provider and observed/configured model IDs, extraction prompt
version, extraction schema version, evaluator/report-schema versions, per-case
field comparisons, and summary metrics. Reports omit input text. The runner
supplies A2's safety check as always-allow because no production classifier is
defined in this repository; the report records this and is not a safety/refusal
evaluation. The checked-in cassettes are development fixtures derived from gold
annotations: replay scores exercise the extraction path and report structure,
but are not model predictions, annotation validation, or genuine accuracy. The
deterministic `fake` provider is also available with `--provider fake`.

Only conservative exact matching is reported. Each field's exact-match rate is
the number of selected cases whose complete value matches the expected value
divided by the selected case count. Scalar values must match exactly; arrays
must match exactly and in order. Explicit year ranges in expected
`time_coverage` are normalized to `YYYY-YYYY`, matching A2; no other
normalization, semantic equivalence, evidence quality, precision/recall, or
annotation correctness is inferred. A non-`ok` extraction has no actual field
values and counts as a mismatch for every field. See `report.schema.json` for
the versioned output contract.

Held-out examples are excluded by default. To run their prompts through the
deterministic fake provider, explicitly pass `--heldout --provider fake`. A
held-out cassette replay requires both `--heldout` and a separate
`--cassette-dir <path>` containing purpose-built held-out cassettes; the
development cassette directory is rejected for held-out runs. Do not copy
held-out rows into development fixtures, prompts, tests, or tuning workflows.
Reports from either deterministic provider remain structural replays, not model
quality evidence.

The baseline writer is intentionally gated:

```powershell
npx tsx evals\update-baseline.ts --accept-structural-replay evals\reports\<report>.json
```

It accepts development-only fake/cassette structural reports and appends a
separately labeled record. It refuses held-out reports, requires the explicit
opt-in flag, and never changes the `NOT RUN` model-quality status or its
unmeasured quality rows. Do not use it to claim accuracy.

## Baseline status

The shared extraction schema, extraction implementation, and Bedrock provider are present, but no live Bedrock run or model-quality baseline has been measured. See `BASELINE.md`; do not replace `NOT RUN` with invented or structure-only metrics.

## Langfuse status and redaction

The project owner reports creating a hosted Langfuse project and configuring its API keys locally. A non-production smoke span and boolean score were delivered to the configured project and inspected; this verifies the smoke integration only, not production application traffic. The latest smoke was run after disabling automatic process/host resource detection, and the inspected metadata contained no process or host identifiers. An earlier pre-fix smoke trace may still retain local process and host metadata; remove it from Langfuse if it should not be retained. Configure retention and separate development/production environments in the team's Langfuse setup. Supply runtime credentials through the approved secret store; never commit credentials or paste them into chat.

Before transmitting data to Langfuse:

- Send only the minimum fields needed for observability: request correlation ID, stage, model/prompt/schema versions, timings, token counts where available, source status/counts, and programmatic evaluation outcomes.
- Do not export raw user queries, raw model prompts/responses, dataset rows/cards, access tokens, credentials, signed URLs, or user identity by default.
- If text capture is explicitly enabled for a controlled development environment, redact likely PII and secrets before export and use a separate development project with short retention.
- Treat all redaction as a pre-export application responsibility; verify it with tests before enabling trace delivery.
- Configure separate development and production projects/environments and least-privilege keys. Keep runtime trace delivery optional so Langfuse outages cannot fail searches.

These are required setup controls, not evidence that trace delivery or application-side redaction has been tested. Application-side pre-export redaction must be implemented and verified before any trace can be considered production-ready.
