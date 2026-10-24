# DataScout LLM baseline

**Status: NOT RUN.**

The v1 requirement contract and extraction implementation exist. The updated plan uses an external LLM provider; no provider has yet been selected/configured and no live model-quality baseline has been measured. Reporting model-quality or operational baseline numbers now would be misleading. The project owner reports creating one Langfuse project and storing API keys locally.

The corpus structural check passed on 2026-10-24 with 50 cases (40 development, 10 held out). The project owner confirmed the REQE-020 evidence correction and current corpus revision. Current corpus SHA-256: `C51FEA6749565DF1889D00FF56F0233D6DDB9FD359ADF01B16308C3DCECD21A5`. Structural validation and review confirmation do not establish model quality.

| Measure | Status | Evidence needed |
| --- | --- | --- |
| Corpus structural validation | PASS (2026-10-24) | `python evals\validate_dataset.py`: 50 cases; development=40; held_out=10. Structural integrity only. |
| Contract/schema conformance | PASS (2026-10-24) | `npm test --workspace=@datascout/contracts`: 42 tests passed; all 50 corpus expected objects validate against contract v1 |
| Human annotation review | Confirmed by project owner (2026-10-24) | User-confirmed review of current corpus revision, hash above |
| Requirement extraction accuracy | Not run | Frozen schema, model/prompt versions, predictions for development and held-out splits |
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
`structural_fixture_replay`. The checked-in cassettes derive from gold
annotations, so their scores are not model predictions or annotation-accuracy
evidence. `evals/update-baseline.ts` requires
`--accept-structural-replay`, accepts development-only reports, and appends a
separately labeled structural record without changing this `NOT RUN` status.
See `evals/README.md` for usage, the exact-match definition, and held-out
handling.
