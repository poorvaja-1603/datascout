# DataScout LLM baseline

**Status: NOT RUN.**

The v1 requirement contract exists, but there is no requirement extractor, Bedrock model configuration, or runtime implementation in the repository. Reporting model-quality or operational baseline numbers now would be misleading. The project owner confirmed reviewing the corpus and reports creating a Langfuse project and configuring API keys locally; those external settings cannot be independently verified from this checkout.

The corpus structural check passed on 2026-10-24 with 50 cases (40 development, 10 held out). The project owner confirmed reviewing the annotations on 2026-10-24. Corpus SHA-256: `842F282E8000D59720AA22B28E83E85809650882C4F2F19B91C26FC2FAB35BD3`. Structural validation and review confirmation do not establish model quality.

| Measure | Status | Evidence needed |
| --- | --- | --- |
| Corpus structural validation | PASS (2026-10-24) | `python evals\validate_dataset.py`: 50 cases; development=40; held_out=10. Structural integrity only. |
| Contract/schema conformance | PASS (2026-10-24) | `npm test --workspace=@datascout/contracts`: 11 tests passed; all 50 corpus expected objects validate against contract v1 |
| Human annotation review | Confirmed by project owner (2026-10-24) | User-confirmed review of the corpus hash above |
| Requirement extraction accuracy | Not run | Frozen schema, model/prompt versions, predictions for development and held-out splits |
| Per-field precision/recall/F1 | Not run | Human-reviewed expected labels and prediction output |
| Retrieval coverage / source success | Not run | Implemented source adapters and recorded source responses/fixtures |
| Verdict accuracy / false-PASS rate | Not run | Evidence fixtures with human-labeled requirement verdicts |
| Evidence grounding / unsupported claims | Not run | Evidence-ID contract and generated claims paired with validated evidence |
| Latency / token use / cost | Not run | Deployed model configuration and reproducible request logs |
| Langfuse project / local keys | Configured (user-reported; not independently verified) | Project owner reports project creation and local key setup |
| Langfuse trace delivery / application-side redaction | Not run | Runtime instrumentation, pre-export redaction tests, and inspection of a delivered non-production trace |

Do not use development cases for final quality claims. Record corpus hash, model ID, prompt version, schema version, evaluator version, split, and run timestamp with every future baseline.
