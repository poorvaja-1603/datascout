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
- Amazon Bedrock for requirement interpretation and grounded guidance
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
