# DataScout AWS Backend Deployment Guide

This guide walks through deploying the DataScout serverless backend infrastructure and Lambda handlers to AWS using the AWS SAM CLI on Windows (PowerShell).

---

## 1. Prerequisites & Verification

Ensure you have the required CLI tools installed and accessible in PowerShell:

```powershell
# Verify Node.js (version 22+)
node -v
npm -v

# Verify AWS CLI v2
aws --version

# Verify AWS SAM CLI
sam --version
```

If SAM CLI is not installed, install it via `winget`:
```powershell
winget install Amazon.SAM-CLI
```

---

## 2. Authentication & Identity Verification

Configure your AWS credentials using AWS CLI profiles or IAM Identity Center (SSO):

```powershell
# Authenticate via IAM Identity Center / SSO (Recommended):
aws sso login --profile datascout-dev

# OR configure standard credentials:
aws configure --profile datascout-dev

# Set the active profile and default region in PowerShell session:
$env:AWS_PROFILE = "datascout-dev"
$env:AWS_REGION = "ap-south-1"

# Verify the active caller identity and region:
aws sts get-caller-identity
```

---

## 3. Project Dependencies & Build

From the repository root, install dependencies and compile TypeScript handlers:

```powershell
# Install root and workspace dependencies:
npm ci

# Compile backend TypeScript handlers:
npm run build --workspace=@datascout/backend

# Run local unit tests to ensure all handlers pass before deploying:
npm test --workspace=@datascout/backend
```

---

## 4. SAM Application Validation & Build

Validate the SAM template syntax and package the artifacts:

```powershell
# Change directory to backend:
cd backend

# Validate template.yaml against AWS Serverless Transform schema:
sam validate --lint

# Build the SAM application container/package:
sam build
```

---

## 5. Review Resources & IAM Permissions

The `backend/template.yaml` defines:
* **Amazon Cognito User Pool**: Email-verified user pool, resource server (`datascout-api`), and scopes (`search`, `read`, `compare`).
* **Amazon API Gateway REST API**: With Cognito User Pool authorizer and GatewayResponses for 401, 403, 413, 429, 504 returning `ErrorObject`.
* **Amazon DynamoDB**:
  * `datascout-results-${Environment}`: Pay-per-request billing, `pk` key, TTL attribute `ttl`.
  * `datascout-datasets-${Environment}`: Pay-per-request billing, `dataset_id` key.
* **Amazon S3**: `datascout-snapshots-...` private bucket with public access block, AES-256 encryption, and 30-day lifecycle rule.
* **AWS Lambda Functions**:
  * `SearchFunction` (`POST /search` with `datascout-api/search` scope)
  * `ResultsFunction` (`GET /results/{request_id}` with `datascout-api/read` scope)
  * `DatasetFunction` (`GET /dataset/{dataset_id}` with `datascout-api/read` scope)
  * `CompareFunction` (`POST /compare` with `datascout-api/compare` scope)
  * `RefreshFunction` (EventBridge daily rate schedule)

---

## 6. Deploying Infrastructure via SAM

Deploy the stack using guided deployment for the first run:

```powershell
sam deploy --guided `
  --stack-name datascout-backend-dev `
  --region ap-south-1 `
  --parameter-overrides Environment=dev CorsAllowedOrigin="*"
```

For subsequent deployments:
```powershell
sam deploy --stack-name datascout-backend-dev --region ap-south-1
```

---

## 7. Retrieving Deployment Outputs

Inspect the deployed outputs to connect the frontend and configure clients:

```powershell
aws cloudformation describe-stacks `
  --stack-name datascout-backend-dev `
  --query "Stacks[0].Outputs" `
  --output table
```

Outputs returned:
1. `ApiEndpoint`: The base URL for the deployed REST API (e.g., `https://<api-id>.execute-api.ap-south-1.amazonaws.com/dev`).
2. `CognitoUserPoolId`: The user pool identifier.
3. `CognitoUserPoolClientId`: The public SPA client ID.
4. `ResultsTableName`: The DynamoDB table name for search results.
5. `DatasetsTableName`: The DynamoDB table name for dataset details.
6. `SnapshotsBucketName`: The private S3 snapshots bucket name.

---

## 8. Verifying Deployed API (Smoke Test)

Verify the deployed protected API endpoints:

```powershell
# 1. Test missing Authorization token (Expect 401 Unauthorized with ErrorObject):
$API_URL = (aws cloudformation describe-stacks --stack-name datascout-backend-dev --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)

Invoke-RestMethod -Uri "$API_URL/search" -Method Post -Body '{"query":"crop yield"}' -ContentType "application/json" -SkipHttpErrorCheck -StatusCodeVariable "code"
Write-Host "Response HTTP Status: $code"

# 2. Test with Cognito user token:
# Obtain token via Cognito initiate-auth or OAuth flow, then call:
$TOKEN = "<COGNITO_ACCESS_TOKEN>"
$Headers = @{
  "Authorization" = "Bearer $TOKEN"
  "Content-Type"  = "application/json"
}

$Body = @{
  query = "Indian crop yield dataset for Maharashtra with rainfall"
} | ConvertTo-Json

Invoke-RestMethod -Uri "$API_URL/search" -Method Post -Headers $Headers -Body $Body
```

---

## 9. Cleanup & Teardown

To delete all deployed AWS resources and prevent ongoing costs:

```powershell
sam delete --stack-name datascout-backend-dev --region ap-south-1
```
