# DataScout LLM baseline

**Status: DEVELOPMENT BASELINE RECORDED; HELD-OUT NOT RUN.**

The v1 requirement contract and extraction implementation exist. A local Ollama development baseline has been measured, but held-out quality and release gates remain unrun. The development result is diagnostic, not release approval.

The corpus structural check passed on 2026-10-24 with 50 cases (40 development, 10 held out). The project owner confirmed the REQE-020 evidence correction and current corpus revision. Current corpus SHA-256: `C51FEA6749565DF1889D00FF56F0233D6DDB9FD359ADF01B16308C3DCECD21A5`. Structural validation and review confirmation do not establish model quality.

| Measure | Status | Evidence needed |
| --- | --- | --- |
| Corpus structural validation | PASS (2026-10-24) | `python evals\validate_dataset.py`: 50 cases; development=40; held_out=10. Structural integrity only. |
| Contract/schema conformance | PASS (2026-10-24) | `npm test --workspace=@datascout/contracts`: 42 tests passed; all 50 corpus expected objects validate against contract v1 |
| Human annotation review | Confirmed by project owner (2026-10-24) | User-confirmed review of current corpus revision, hash above |
| Requirement extraction accuracy | Development measured; held-out not run | Local Ollama qwen3:8b, 40 development cases; report: `evals/reports/model-qwen3-8b-2026-10-24T19-32-30-452Z-development.json` |
| Per-field precision/recall/F1 | Not run | Human-reviewed expected labels and prediction output |
| Retrieval coverage / source success | Not run | Implemented source adapters and recorded source responses/fixtures |
| Verdict accuracy / false-PASS rate | Not run | Evidence fixtures with human-labeled requirement verdicts |
| Evidence grounding / unsupported claims | Not run | Evidence-ID contract and generated claims paired with validated evidence |
| Latency / token use / cost | Not run | Deployed model configuration and reproducible request logs |
| Langfuse project / local keys | Smoke-verified (2026-10-24) | Non-production smoke span and boolean score delivered to the configured project |
| Langfuse trace delivery | Smoke-verified (2026-10-24); current runtime unavailable | Prior non-production smoke trace was inspected. No production application traffic was traced; credentials are not configured in this checkout environment |
| Application-side redaction | Unit tests pass; production verification pending | Tests cover email, bearer/Langfuse/AWS credentials, Indian phone, Aadhaar/PAN-like identifiers, JWT-like tokens, and credential query parameters; this is not exhaustive and no current live application trace was inspected |
| Managed Bedrock Guardrails | Out of scope for Learner Lab | Updated plan replaces them with application-level safety layers |

Do not use development cases for final quality claims. Record corpus hash, model ID, prompt version, schema version, evaluator version, split, and run timestamp with every future baseline.

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
