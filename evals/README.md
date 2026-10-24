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

## Baseline status

The shared extraction schema is defined in `contracts/`, but no extraction implementation, Bedrock configuration, or model version exists in this repository. Therefore no model baseline has been measured. See `BASELINE.md`; do not replace `NOT_RUN` with invented or structure-only metrics.

## Langfuse status and redaction

The project owner reports creating a hosted Langfuse project and configuring its API keys locally. This repository cannot validate the keys or project settings, and no application runtime exists to send and inspect a trace. Configure retention and separate development/production environments in the team's Langfuse setup. Supply runtime credentials through the approved secret store; never commit credentials or paste them into chat.

Before transmitting data to Langfuse:

- Send only the minimum fields needed for observability: request correlation ID, stage, model/prompt/schema versions, timings, token counts where available, source status/counts, and programmatic evaluation outcomes.
- Do not export raw user queries, raw model prompts/responses, dataset rows/cards, access tokens, credentials, signed URLs, or user identity by default.
- If text capture is explicitly enabled for a controlled development environment, redact likely PII and secrets before export and use a separate development project with short retention.
- Treat all redaction as a pre-export application responsibility; verify it with tests before enabling trace delivery.
- Configure separate development and production projects/environments and least-privilege keys. Keep runtime trace delivery optional so Langfuse outages cannot fail searches.

These are required setup controls, not evidence that trace delivery or application-side redaction has been tested. Application-side pre-export redaction must be implemented and verified before any trace can be considered production-ready.
