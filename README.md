# DataScout

DataScout helps users find public datasets that fit a data science or machine-learning project. It combines natural-language requirement extraction with source-backed, deterministic verification and transparent recommendations.

## Start Here

- Product requirements: [`docs/PRD.md`](docs/PRD.md)
- End-to-end MVP development plan: [`docs/plan.md`](docs/plan.md)
- Provisional LLM evaluation corpus and baseline status: [`evals/README.md`](evals/README.md)

The implementation is organized as npm workspaces following the streams and contract-first milestones in the development plan.

## Planned Stack

- React frontend hosted on AWS Amplify
- API Gateway and AWS Lambda REST backend
- Gemini as the hosted LLM provider, with Ollama for local development; Bedrock is unavailable to the Learner Lab role
- DynamoDB for dataset metadata and result cache
- S3 for private metadata snapshots and permitted samples
- EventBridge for bounded catalog refresh
- Langfuse for redacted LLM tracing and evaluation
- Amazon Cognito User Pools for verified user identity and access tokens

Planned dataset sources: data.gov.in, Hugging Face Datasets, OpenML, and the World Bank Indicators API.

## Repository

```text
contracts/               Shared contracts and API schemas (Stream A)
packages/ai/              LLM clients and extraction (Stream A)
packages/verify/          Deterministic matching and scoring (Stream A)
packages/observability/   Langfuse tracing and redaction (Stream A)
evals/                    Evaluation corpus and runners (Stream A)
docs/                     Product requirements and implementation plan
README.md                 Project overview
```

## Langfuse observability

The observability package uses Langfuse JS/TS SDK v6 with OpenTelemetry. Set
`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and the region-specific
`LANGFUSE_BASE_URL` in an untracked local `.env` (or inject them from the
deployment secret store). Optional `LANGFUSE_TRACING_ENVIRONMENT` and
`LANGFUSE_RELEASE` label traces. Missing or malformed configuration disables
tracing; telemetry exporter failures are logged without failing the
application. Do not add prompts, queries, request bodies, or credentials to
span attributes.

Create the tracer once after loading environment variables with
`createLangfuseTracer()`. Flush it with a bounded timeout after short-lived
work; Lambda handlers should flush before returning. Run
`npm run langfuse:smoke` with credentials configured to send a trace and
`observability_smoke` score, then verify `datascout.observability.smoke` in
the Langfuse project. This live smoke step requires project credentials and
network access and is not replaced by unit tests.
