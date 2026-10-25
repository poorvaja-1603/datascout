# LLM Provider Decision

**Status: Provider selected; exact Gemini model pending.** Gemini is the hosted provider for deployment, and Ollama is supported for local development/offline use. Keep tests on `fake` or `cassette`; tests use mocked fetch and make no provider calls.

## Decision criteria

- A free or low-cost quota sufficient for repeated development and the 50-case evaluation corpus.
- Reliable structured JSON output through Gemini's native response schema; Ollama's native schema format supports local development.
- Data retention and model-training terms acceptable for user queries leaving AWS.
- A stable, pinnable model identifier and acceptable latency from the Lambda deployment region.
- A documented fallback provider, if the team's budget and terms permit one.

## Record before enabling hosted calls

| Item | Decision |
| --- | --- |
| Hosted provider | Gemini |
| Local provider | Ollama; local development only, not a Lambda fallback |
| Provider plan and free quota | Pending verification |
| Gemini model ID (pinned) | Pending selection |
| API base URL | Gemini API endpoint is fixed in code; Ollama base URL is local configuration |
| Data retention and training terms URL | Pending review |
| Expected calls per search and evaluation run | Pending estimate |
| Automatic hosted fallback | None; do not route queries to Ollama from deployed Lambda by default |
| Decision date and approver | Pending |

Store credentials only in the approved secret store or an untracked local `.env`. Never commit keys or put them in the frontend. Before a live evaluation, estimate its cost and run the smallest useful sample first.
