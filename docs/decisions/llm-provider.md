# LLM Provider Decision

**Status: Gemini selected and verified for generation; pinned to `gemini-2.5-flash`.** Live single-call structured JSON generation succeeded on 2026-10-25: HTTP 200, model `gemini-2.5-flash`, schema valid, latency 1,188 ms (`evals/reports/gemini-smoke-2026-10-25T11-32-51-859Z.json`). Diagnostic checks confirmed that `gemini-3.8-flash` was intermittently returning HTTP 503 from Google due to high demand spikes and rejected `thinkingLevel` on 2.x models. The client in `packages/ai/src/client.ts` was updated with model-adaptive thinking configuration (`thinkingBudget: 0` for 2.x/2.5 models and `thinkingLevel: 'low'` for 3.x models), and `gemini-2.5-flash` was pinned in configuration. Ollama remains supported for local offline development. Unit tests continue to run on `fake` or `cassette` without network access.

## Decision criteria

- A free or low-cost quota sufficient for repeated development and the 50-case evaluation corpus.
- Reliable structured JSON output through Gemini's native response schema; Ollama's native schema format supports local development.
- Data retention and model-training terms acceptable for user queries leaving AWS.
- A stable, pinnable model identifier and acceptable latency from the Lambda deployment region (~1.2s for Gemini 2.5 Flash).
- A documented fallback provider, if the team's budget and terms permit one.

## Record before enabling hosted calls

| Item | Decision |
| --- | --- |
| Hosted provider | Gemini |
| Local provider | Ollama; local development only, not a Lambda fallback |
| Provider plan and free quota | Google AI Studio free tier / standard tier API quota verified |
| Gemini model ID (pinned) | `gemini-2.5-flash`; metadata lookup PASS, generation smoke PASS (HTTP 200, 1.18s) |
| API base URL | `https://generativelanguage.googleapis.com/v1beta` (fixed in code) |
| Data retention and training terms URL | Google Generative AI Terms of Service |
| Expected calls per search and evaluation run | 1 extraction call + optional explanation call per search; 40 calls per dev eval run |
| Automatic hosted fallback | None; do not route queries to Ollama from deployed Lambda by default |
| Decision date and approver | 2026-10-25; Member A verified |

Google's [Gemini API model catalog](https://ai.google.dev/gemini-api/docs/models) lists the configured model; the successful metadata report is `evals/reports/gemini-connectivity-2026-10-25T08-37-20-191Z.json`. Google's [thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking) explains that reasoning tokens count against the output cap and that low thinking reduces latency/cost; the application now sets low thinking and omits `temperature` for Gemini. The [API billing guide](https://ai.google.dev/gemini-api/docs/billing) says usage depends on input/output/cached tokens and quota is visible in AI Studio. Metadata lookup does not generate text or establish generation billing/usage. The earlier generation failures had no HTTP response or usage metadata; inspect AI Studio request/usage status before another generation attempt.

Store credentials only in the approved secret store or an untracked local `.env`. Never commit keys or put them in the frontend. Before a live evaluation, estimate its cost and run the smallest useful sample first.
