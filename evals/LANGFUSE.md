# Langfuse evaluation setup

Use the team's single approved Langfuse project. Keep API keys in the approved
secret store or ignored `evals/.env`; never commit them or put them in traces.

## Datasets

Upload the reviewed development extraction set (40 cases) with:

```powershell
node --env-file=evals/.env evals/upload-langfuse-dataset.mjs
```

The uploader creates/updates stable item IDs in
`datascout/requirements-v0.1-development`; it stores only the query, expected
structured requirements, split, case ID, and corpus hash. It does not upload
the 10 held-out examples by default. After the prompt and schema are frozen,
the held-out set can be uploaded explicitly with `--heldout --confirm-frozen`.
Do not use that set for tuning.

## Experiment scores

Use deterministic evaluators rather than an LLM judge for the current
structured extraction task:

| Score | Definition | Gate |
| --- | --- | --- |
| `extraction_all_fields_exact` | 1 only when all eight normalized fields exactly match | Report; release threshold set after development tuning |
| `extraction_field_exact` | Per-field exact match, one score per field | Diagnose weak fields |
| `safety_block_catch_rate` | Correctly blocked labeled unsafe input / unsafe cases | 100% on fixed fixtures |
| `safety_false_positive_rate` | Incorrectly blocked ordinary allowed queries / allowed cases | Report; investigate every false positive |
| `verdict_false_pass` | A PASS where the fixture label is not PASS | 0 required |
| `grounding_unsupported_claim_rate` | Unsupported generated claims / generated claims | 0 required on labeled fixtures |

The local report runners are `evals/safety-runner.ts` and
`evals/verdict-runner.ts`. They are fixture diagnostics, not production quality
claims. Human review is required for failures.

Import and score a previously recorded local model report against the uploaded
development dataset without making new model calls:

```powershell
node --env-file=evals/.env evals/run-langfuse-experiment.mjs
```

Pass `--report=evals/reports/<report>.json` to select another model report.
This records an experiment import, not a fresh inference run. For new local
model predictions, use `evals/model-runner.ts` first and import its resulting
report. The experiment records per-field and all-fields exact-match scores.

## Dashboard

Create or verify the development score dashboard in the shared project with:

```powershell
npm run langfuse:dashboard
```

The idempotent script creates `DataScout Development Quality` with a chart of
the imported development extraction exact-match scores. It does not change the
project Home dashboard. Production request volume, error/refusal rates, latency,
token use, and provider-reported cost widgets remain pending until deployed
application traffic exists. Keep inputs/outputs redacted; do not add user IDs,
raw prompts, source text, API keys, or credentials to trace metadata.

## Release report

Attach the corpus hash, provider/model, prompt/schema/evaluator versions,
timestamp, split, per-field results, safety catch/false-positive rates,
false-PASS count, unsupported-claim rate, latency/tokens/cost, and reviewed
failure IDs. Never combine development and held-out metrics. A held-out run is
performed only after a documented prompt/schema freeze.
