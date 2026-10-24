# DataScout

DataScout helps users find public datasets that fit a data science or machine-learning project. It combines natural-language requirement extraction with source-backed, deterministic verification and transparent recommendations.

## Start Here

- Product requirements: [`docs/PRD.md`](docs/PRD.md)
- End-to-end MVP development plan: [`docs/plan.md`](docs/plan.md)

The repository is intentionally reset to documentation and planning. The earlier starter application has been removed so implementation can begin against the current PRD and plan.

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
docs/PRD.md    Product requirements
docs/plan.md   End-to-end implementation plan
README.md      Project overview
```
