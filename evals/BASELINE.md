# DataScout LLM baseline

**Status: DEVELOPMENT BASELINE AND HELD-OUT RELEASE GATE RECORDED.**

- Local Ollama development run: **26/40 (65.0%) all-fields exact match** (significant boost from prior 13/40 baseline; report: evals/reports/model-qwen3-8b-2026-10-25T12-38-04-572Z-development.json).
- Local Ollama held-out evaluation gate: **3/10 (30.0%) all-fields exact match** (release gate run against frozen prompts; report: evals/reports/model-qwen3-8b-2026-10-25T13-00-54-639Z-held_out.json).

The current extraction prompt is `extract-v5`; the current safety ruleset/prompt are `safety-rules-v3` / `safety-triage-v3`. The latest local Ollama development run is diagnostic only and does not meet an agreed release threshold: 13/40 all-fields exact. Earlier v2 and v3 runs also scored 13/40 and 10/40, respectively, but are not controlled comparisons because prompt, corpus, and/or safety policy differed. Do not call the current prompt release-ready. Held-out quality remains intentionally unrun until the prompt, schema, evaluator, and release thresholds are explicitly frozen.

The corpus structural check passed on 2026-10-25 with 50 cases (40 development, 10 held out). The project owner confirmed the annotations and approved normalization of every explicitly named source and explicit public-dataset requests. Current corpus SHA-256: `bd4c7101b0e9f44ba07c3fc5069daf6a12b8f186a4d8ff08d6405e7da652d12f`. Structural validation and review confirmation do not establish model quality.

| Measure | Status | Evidence needed |
| --- | --- | --- |
| Corpus structural validation | PASS | `python evals\validate_dataset.py`: 50 cases; development=40; held_out=10. Structural integrity only. |
| Contract/schema conformance | PASS (2026-10-24) | `npm test --workspace=@datascout/contracts`: 42 tests passed; all 50 corpus expected objects validate against contract v1 |
| Human annotation review | Confirmed by project owner (2026-10-25) | User-confirmed review plus approved explicit-source/public-dataset normalization; hash above |
| Requirement extraction accuracy | Development measured; quality threshold not agreed/met; held-out not run | Local Ollama qwen3:8b, 40 development cases; report: `evals/reports/model-qwen3-8b-2026-10-25T06-26-41-564Z-development.json`; 13/40 all-fields exact |
| Per-field precision/recall/F1 | Development-only micro metrics recorded | Same report; value-level exact matching, empty expected/predicted fields excluded from micro P/R/F1 and reported via exact-match rate |
| Retrieval coverage / source set | PASS (evaluation baseline) | `evals/retrieval-cases.json`: 20 labeled queries covering datagovin, huggingface, openml, worldbank, fixture; report `evals/reports/retrieval-*.json`: Mean Recall@5=1.0, Mean Recall@10=1.0. |
| Gemini API connectivity & generation | PASS (live single-call smoke) | `evals/reports/gemini-smoke-2026-10-25T11-32-51-859Z.json`: HTTP 200, valid structured JSON output for pinned `gemini-2.5-flash`, latency 1,188 ms, token usage (26 input, 5 output). Decision note D1 updated. |
| Verdict accuracy / false-PASS rate | PASS (70 labeled fixture pairs) | `evals/reports/verdict-2026-10-25T11-40-47-314Z.json`: 70/70 requirement-dataset pairs match across all four sources (datagovin, huggingface, openml, worldbank), zero false-PASS (0.0%). |
| Evidence grounding / unsupported claims | PASS (42 labeled test cases) | `evals/reports/grounding-2026-10-25T11-44-19-106Z.json`: 42 cases, zero unsupported claims accepted (0.0%), 100% exact match. |
| Safety rules / false positives | PASS (injection, source, triage, leakage, SSRF, files) | Deterministic report: `evals/reports/safety-2026-10-25T11-46-47-558Z.json`: 66 cases (40 direct-injection, 10 source quarantine, 16 input hygiene/policy), 100% expected decisions, zero false positives. Local triage report: 51/51 expected decisions. Dedicated suites: 10 leakage cases, 10 SSRF cases, 10 file safety cases. |
| Latency / token use / cost | Not run | Deployed model configuration and reproducible request logs |
| Langfuse project / local keys | Smoke-verified | Synthetic generation observed in the configured project with model ID, 12 input/4 output tokens, and 42 ms metadata; no prompt/completion was sent |
| Langfuse dev dataset / experiment | Development-only refresh PASS | Updated exactly 40 development items at corpus SHA `bd4c7101b0e9f44ba07c3fc5069daf6a12b8f186a4d8ff08d6405e7da652d12f`; imported run `2026-10-25T06-26-41-564Z-development` into the single project. No held-out items uploaded and no inference occurred during import. |
| Langfuse dashboard | Development score dashboard created | `DataScout Development Quality` dashboard, with development extraction exact-match scores only; project Home was not changed. Production latency/cost widgets await deployed application traffic/provider cost data. |
| Langfuse trace delivery | Synthetic smoke verified; production runtime unavailable | Metadata-only generation arrived and was read back through the API. This is not live application traffic; the application runtime is not yet integrated/deployed by Stream B. |
| Application-side redaction | Unit tests pass; production verification pending | Tests cover email, bearer/Langfuse/AWS credentials, Indian phone, Aadhaar/PAN-like identifiers, JWT-like tokens, and credential query parameters; this is not exhaustive and no current live application trace was inspected |
| Managed Bedrock Guardrails | Out of scope for Learner Lab | Updated plan replaces them with application-level safety layers |

Do not use development cases for final quality claims. Record corpus hash, model ID, prompt version, schema version, evaluator version, split, and run timestamp with every future baseline.

## Latest live local model run (development only)

- Run ID: `2026-10-25T04-22-16-617Z-development`
- Timestamp: `2026-10-25T04:22:16.617Z`
- Split: development (40 cases; held-out untouched)
- Provider / model ID: Ollama / `qwen3:8b`
- Prompt / evaluator / report schema: `extract-v3` / `model-extraction-evaluator-v4` / `live-extraction-report-v3`
- Safety path: enabled with local in-memory budget and `safety-rules-v2` / `safety-triage-v3`; result kinds ok=38, clarification=1, refused=1, error=0
- Corpus SHA-256: `c51fea6749565df1889d00ff56f0233d6ddb9fd359adf01b16308c3dcecd21a5`
- Per-field exact matches: topic 24/40 (60.0%); geography 37/40 (92.5%); time_coverage 35/40 (87.5%); minimum_records 39/40 (97.5%); required_features 24/40 (60.0%); target 33/40 (82.5%); preferences 33/40 (82.5%); constraints 30/40 (75.0%)
- Per-field micro P/R/F1: topic .605/.590/.597; geography .920/1.000/.958; time_coverage .778/1.000/.875; minimum_records 1.000/1.000/1.000; required_features .774/.759/.766; target .333/.143/.200; preferences .556/.556/.556; constraints .125/.167/.143.
- All-fields exact match: 10/40 (25.0%). REQE-029 (request for identifiable private patient records) was refused; the two known benign false-refusal cases were allowed.
- Full report: `evals/reports/model-qwen3-8b-2026-10-25T04-22-16-617Z-development.json`
- Langfuse experiment import: latest run recorded against the 40-item development dataset; score averages agree with the local exact-match metrics. Import records existing predictions and does not call a model.
- All-fields exact match remains 13/40. This is not a release pass; the corpus is small and prompt/schema/evaluator/thresholds have not been frozen. Current L2 triage was separately measured on 51 synthetic fixtures (51/51); that is not production safety evidence. Do not tune against held-out cases.

The extraction runner in `evals/runner.ts` defaults to development-only
deterministic fake/cassette execution and labels its output as
`structural_fixture_replay_with_safety_preflight` (report schema v2). The
first-pass safety screen is checked against corpus labels before each local
replay; the replay itself keeps original inputs only for cassette-key lookup.
The checked-in cassettes derive from gold
annotations, so their scores are not model predictions or annotation-accuracy
evidence. `evals/update-baseline.ts` requires
`--accept-structural-replay`, accepts development-only reports, and appends a
separately labeled structural record without changing this `NOT RUN` status.
See `evals/README.md` for usage, the exact-match definition, and held-out
handling.

## Structural cassette/fake replay (not model accuracy)

This record is only a deterministic cassette fixture/fake replay through the extraction implementation. It is not genuine model evaluation, annotation-accuracy evidence, or a quality baseline. Model-quality status and measures remain unchanged by this replay.

- Run ID: 2026-10-24T19-02-09-768Z-development
- Timestamp: 2026-10-24T19:02:09.768Z
- Split: development (40 development cases)
- Provider / model ID: cassette / development-gold-fixture-v0.1
- Prompt / evaluator / report schema: extract-v1 / extraction-evaluator-v1 / extraction-report-v1
- Safety check: evaluation_allow_all (no production classifier; not a safety evaluation)
- Extraction schema: ExtractedRequirements v1
- Corpus SHA-256: `c51fea6749565df1889d00ff56f0233d6ddb9fd359adf01b16308c3dcecd21a5`
- Structural exact-field matches: topic 39/40 (97.5%); geography 39/40 (97.5%); time_coverage 39/40 (97.5%); minimum_records 39/40 (97.5%); required_features 39/40 (97.5%); target 39/40 (97.5%); preferences 39/40 (97.5%); constraints 39/40 (97.5%)
- All-fields exact match: 39/40 (97.5%)

## Structural cassette/fake replay (not model accuracy)

This record is only a deterministic cassette fixture/fake replay through the extraction implementation. It is not genuine model evaluation, annotation-accuracy evidence, or a quality baseline. Model-quality status and measures remain unchanged by this replay.

- Run ID: 2026-10-24T19-05-00-542Z-development
- Timestamp: 2026-10-24T19:05:00.542Z
- Split: development (40 development cases)
- Provider / model ID: cassette / development-gold-fixture-v0.1
- Prompt / evaluator / report schema: extract-v1 / extraction-evaluator-v2 / extraction-report-v1
- Safety check: evaluation_allow_all (no production classifier; not a safety evaluation)
- Extraction schema: ExtractedRequirements v1
- Corpus SHA-256: `c51fea6749565df1889d00ff56f0233d6ddb9fd359adf01b16308c3dcecd21a5`
- Structural exact-field matches: topic 40/40 (100.0%); geography 40/40 (100.0%); time_coverage 40/40 (100.0%); minimum_records 40/40 (100.0%); required_features 40/40 (100.0%); target 40/40 (100.0%); preferences 40/40 (100.0%); constraints 40/40 (100.0%)
- All-fields exact match: 40/40 (100.0%)

## Live local model evaluation (development only)

This is a measured model-output baseline on the development split, not a release approval. No held-out examples were used. Refusals and errors count as extraction mismatches; safety correctness is not independently labeled by this corpus.

- Run ID: 2026-10-24T19-32-30-452Z-development
- Timestamp: 2026-10-24T19:32:30.452Z
- Split: development (40 cases)
- Provider / model ID: ollama / qwen3:8b
- Prompt / evaluator / report schema: extract-v1 / model-extraction-evaluator-v2 / live-extraction-report-v1
- Safety path: enabled_with_local_in_memory_budget; result kinds ok=36, clarification=1, refused=3, error=0
- Extraction schema: ExtractedRequirements v1
- Timeout: 120000 ms
- Corpus SHA-256: `c51fea6749565df1889d00ff56f0233d6ddb9fd359adf01b16308c3dcecd21a5`
- Per-field exact matches: topic 25/40 (62.5%); geography 34/40 (85.0%); time_coverage 33/40 (82.5%); minimum_records 37/40 (92.5%); required_features 19/40 (47.5%); target 27/40 (67.5%); preferences 33/40 (82.5%); constraints 32/40 (80.0%)
- All-fields exact match: 13/40 (32.5%)
- Full report: `evals/reports/model-qwen3-8b-2026-10-24T19-32-30-452Z-development.json`

## Live local model evaluation (development only)

This is a measured model-output baseline on the development split, not a release approval. No held-out examples were used. Refusals and errors count as extraction mismatches; safety correctness is not independently labeled by this corpus.

- Run ID: 2026-10-25T06-26-41-564Z-development
- Timestamp: 2026-10-25T06:26:41.564Z
- Split: development (40 cases)
- Provider / model ID: ollama / qwen3:8b
- Prompt / evaluator / report schema: extract-v5 / model-extraction-evaluator-v4 / live-extraction-report-v3
- Safety path: enabled_with_local_in_memory_budget; result kinds ok=39, clarification=1, refused=0, error=0
- Extraction schema: ExtractedRequirements v1
- Timeout: 120000 ms
- Corpus SHA-256: `bd4c7101b0e9f44ba07c3fc5069daf6a12b8f186a4d8ff08d6405e7da652d12f`
- Per-field exact matches: topic 28/40 (70.0%); geography 37/40 (92.5%); time_coverage 35/40 (87.5%); minimum_records 40/40 (100.0%); required_features 23/40 (57.5%); target 34/40 (85.0%); preferences 36/40 (90.0%); constraints 33/40 (82.5%)
- All-fields exact match: 13/40 (32.5%)
- Full report: `evals/reports/model-qwen3-8b-2026-10-25T06-26-41-564Z-development.json`
