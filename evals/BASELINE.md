# DataScout LLM baseline

**Status: NOT RUN.**

The v1 requirement contract, extraction implementation, and Bedrock provider exist, but no live Bedrock run or model-quality baseline has been measured. Reporting model-quality or operational baseline numbers now would be misleading. The project owner confirmed reviewing the corpus and reports creating a Langfuse project and configuring API keys locally.

The corpus structural check passed on 2026-10-24 with 50 cases (40 development, 10 held out). The project owner confirmed reviewing the annotations on 2026-10-24. Corpus SHA-256: `842F282E8000D59720AA22B28E83E85809650882C4F2F19B91C26FC2FAB35BD3`. Structural validation and review confirmation do not establish model quality.

| Measure | Status | Evidence needed |
| --- | --- | --- |
| Corpus structural validation | PASS (2026-10-24) | `python evals\validate_dataset.py`: 50 cases; development=40; held_out=10. Structural integrity only. |
| Contract/schema conformance | PASS (2026-10-24) | `npm test --workspace=@datascout/contracts`: 42 tests passed; all 50 corpus expected objects validate against contract v1 |
| Human annotation review | Confirmed by project owner (2026-10-24) | User-confirmed review of the corpus hash above |
| Requirement extraction accuracy | Not run | Frozen schema, model/prompt versions, predictions for development and held-out splits |
| Per-field precision/recall/F1 | Not run | Human-reviewed expected labels and prediction output |
| Retrieval coverage / source success | Not run | Implemented source adapters and recorded source responses/fixtures |
| Verdict accuracy / false-PASS rate | Not run | Evidence fixtures with human-labeled requirement verdicts |
| Evidence grounding / unsupported claims | Not run | Evidence-ID contract and generated claims paired with validated evidence |
| Latency / token use / cost | Not run | Deployed model configuration and reproducible request logs |
| Langfuse project / local keys | Smoke-verified (2026-10-24) | Non-production smoke span and boolean score delivered to the configured project |
| Langfuse trace delivery / application-side redaction | PASS for latest smoke (2026-10-24) | Pre-export redaction tests passed; inspected latest smoke metadata contains no process or host identifiers. An earlier pre-fix smoke trace may retain local metadata and should be removed if no longer wanted. No production application traffic was traced. |

Do not use development cases for final quality claims. Record corpus hash, model ID, prompt version, schema version, evaluator version, split, and run timestamp with every future baseline.

The extraction runner in `evals/runner.ts` defaults to development-only
deterministic fake/cassette execution and labels its output as
`structural_fixture_replay`. The checked-in cassettes derive from gold
annotations, so their scores are not model predictions or annotation-accuracy
evidence. `evals/update-baseline.ts` requires
`--accept-structural-replay`, accepts development-only reports, and appends a
separately labeled structural record without changing this `NOT RUN` status.
See `evals/README.md` for usage, the exact-match definition, and held-out
handling.
