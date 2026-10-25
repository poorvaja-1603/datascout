# DataScout AWS Backend Deployment Guide

This checklist prepares the DataScout serverless backend for an explicitly approved deployment. Running the local build and validation steps does not deploy resources. Stop before `sam deploy` until deployment is approved.

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

## 2. Local build and template validation

From the repository root, run the existing checks and create the five minimal
function packages. Then validate and build the actual deployment template:

```powershell
npm ci
npm test
npm run lint
npm run build
npm run package:lambda --workspace=@datascout/backend
Set-Location backend
sam validate --lint --template-file template.yaml
sam build --template-file template.yaml
```

Confirm the build contains `SearchFunction`, `ResultsFunction`, `DatasetFunction`,
`CompareFunction`, and `RefreshFunction`. Each `CodeUri` in `template.yaml` must
point to `backend/.aws-sam/minimal/<FunctionName>`; do not replace these with the
repository root. The package script writes a SHA-256 inventory and fails on
credential-like values or excluded files.

## 3. AWS identity and required permissions

### AWS Academy Learner Lab (recommended path)

AWS Academy provides temporary session credentials that rotate every lab session.
All resources must be deployed to **`us-east-1`** (the only region available).

```powershell
# 1. Start your Learner Lab, then click "AWS Details" → "Show" next to "AWS CLI".
#    Copy the three lines that look like:
#      aws_access_key_id     = ASIA...
#      aws_secret_access_key = ...
#      aws_session_token     = ...

# 2. Paste them into your .env (these rotate every session):
#      AWS_ACCESS_KEY_ID=ASIA...
#      AWS_SECRET_ACCESS_KEY=...
#      AWS_SESSION_TOKEN=...

# 3. OR write them directly to your default AWS CLI profile:
$awsDir = "$HOME\.aws"
New-Item -ItemType Directory -Force -Path $awsDir | Out-Null
# Edit $awsDir\credentials and add:
# [default]
# aws_access_key_id     = ASIA...
# aws_secret_access_key = ...
# aws_session_token     = ...

# 4. Set region for this session:
$env:AWS_DEFAULT_REGION = "us-east-1"

# 5. Verify identity (must show LabRole in the Arn field):
aws sts get-caller-identity
```

> **Important**: You cannot create new IAM roles in AWS Academy. The SAM template
> uses the pre-provisioned `LabRole`. Do **not** pass `--capabilities CAPABILITY_IAM`
> without also passing `--role-arn` pointing to `LabRole`. See Step 5 below.

Once the account is confirmed, inspect only secret metadata (never retrieve or
print a secret value):

```powershell
aws secretsmanager describe-secret `
  --secret-id datascout/dev/data-govin-api-key `
  --region us-east-1 `
  --query "{Name:Name,ARN:ARN}" --output table

aws secretsmanager describe-secret `
  --secret-id datascout/dev/huggingface-api-token `
  --region us-east-1 `
  --query "{Name:Name,ARN:ARN}" --output table

aws cloudformation describe-stacks `
  --stack-name datascout-backend-dev `
  --region us-east-1 `
  --query "Stacks[0].[StackName,StackStatus]" --output table
```

An absent optional secret or first-time stack may return `ResourceNotFound` or
`ValidationError`; those responses make no changes. If secrets exist, compare
their returned ARNs with the planned `DataGovInApiSecretArn` and
`HuggingFaceApiSecretArn` parameter values.

---

The deployment identity needs permission to:

* Operate the named CloudFormation stack and its change sets: `CreateStack`,
  `UpdateStack`, `DeleteStack`, `DescribeStacks`, `DescribeStackEvents`,
  `ListStackResources`, `CreateChangeSet`, `DescribeChangeSet`,
  `ExecuteChangeSet`, `DeleteChangeSet`, `GetTemplate`,
  `GetTemplateSummary`, and `ValidateTemplate`.
* Upload/read deployment artifacts in the SAM-managed S3 bucket:
  `s3:CreateBucket` when using `--resolve-s3`, `s3:GetBucketLocation`,
  `s3:ListBucket`, `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` for
  that bucket.
* Let CloudFormation create and pass the function execution roles:
  `iam:CreateRole`, `iam:GetRole`, `iam:DeleteRole`, `iam:TagRole`,
  `iam:UntagRole`, `iam:PutRolePolicy`, `iam:GetRolePolicy`,
  `iam:DeleteRolePolicy`, `iam:AttachRolePolicy`, `iam:DetachRolePolicy`, and
  `iam:PassRole` restricted to the roles in this stack and the Lambda service.
* Create/update/delete the stack's resources with these service actions:
  * Lambda: `CreateFunction`, `UpdateFunctionCode`,
    `UpdateFunctionConfiguration`, `DeleteFunction`, `GetFunction`,
    `GetFunctionConfiguration`, `AddPermission`, `RemovePermission`,
    `GetPolicy`, `TagResource`, and `UntagResource`.
  * API Gateway REST API: `apigateway:GET`, `POST`, `PUT`, `PATCH`, and
    `DELETE` for the stack's REST API resources.
  * Cognito: `CreateUserPool`, `DescribeUserPool`, `UpdateUserPool`,
    `DeleteUserPool`, `CreateUserPoolClient`, `DescribeUserPoolClient`,
    `UpdateUserPoolClient`, `DeleteUserPoolClient`, `CreateResourceServer`,
    `DescribeResourceServer`, `UpdateResourceServer`, `DeleteResourceServer`,
    `ListTagsForResource`, `TagResource`, and `UntagResource`.
  * DynamoDB: `CreateTable`, `DescribeTable`, `UpdateTable`, `DeleteTable`,
    `DescribeTimeToLive`, `UpdateTimeToLive`, `TagResource`, and `UntagResource`.
  * S3 bucket configuration: `CreateBucket`, `DeleteBucket`, `GetBucketLocation`,
    `GetBucketPublicAccessBlock`, `PutBucketPublicAccessBlock`,
    `GetEncryptionConfiguration`, `PutEncryptionConfiguration`,
    `GetLifecycleConfiguration`, `PutLifecycleConfiguration`,
    `GetBucketTagging`, `PutBucketTagging`, and `DeleteBucketTagging`.
  * EventBridge: `PutRule`, `DescribeRule`, `EnableRule`, `DisableRule`,
    `DeleteRule`, `PutTargets`, `ListTargetsByRule`, `RemoveTargets`,
    `ListTagsForResource`, `TagResource`, and `UntagResource`.
  * CloudWatch alarms: `PutMetricAlarm`, `DescribeAlarms`, and `DeleteAlarms`.
  Scope service actions to the deployment account, region, stack resources, and
  required resource names wherever AWS supports it.
* If `--resolve-s3` must create the SAM artifact bucket, allow bucket creation
  and configuration in the chosen region. Prefer a pre-created, dedicated
  deployment bucket when organizational policy requires one.

CloudFormation's execution identity needs the corresponding resource creation,
configuration, tagging, read, and deletion actions for those services. It also
needs `iam:PassRole` for the Lambda roles. Use a dedicated CloudFormation
execution role and a permissions boundary if required by the account.

Lambda execution roles receive only the runtime permissions in the template:
DynamoDB access for their required tables, S3 access for refresh snapshots,
and `secretsmanager:GetSecretValue` for the specific source-secret ARNs attached
to Search or Refresh. If those secrets use a customer-managed KMS key, grant
`kms:Decrypt` on that key to those execution roles and allow the key policy to
delegate that use. SAM also grants the functions `logs:CreateLogGroup`,
`logs:CreateLogStream`, `logs:PutLogEvents`, `xray:PutTraceSegments`, and
`xray:PutTelemetryRecords` for runtime logging and active tracing. Do not grant
`secretsmanager:*` or wildcard secret access.

The identity that creates or rotates the external secrets separately needs
`secretsmanager:CreateSecret`, `secretsmanager:PutSecretValue`,
`secretsmanager:UpdateSecret`, `secretsmanager:DescribeSecret`, and
`secretsmanager:TagResource` scoped to these secret names. The Lambda roles do
not need these write permissions.

## 4. Review resources and external credentials

The `backend/template.yaml` defines:
* **Amazon Cognito User Pool**: Email-verified user pool, resource server (`datascout-api`), and scopes (`search`, `read`, `compare`).
* **Amazon API Gateway REST API**: With Cognito User Pool authorizer and GatewayResponses for 401, 403, 413, 429, 504 returning `ErrorObject`.
* **Amazon DynamoDB**:
  * `datascout-results-${Environment}`: Pay-per-request billing, `pk` key, TTL attribute `ttl`.
  * `datascout-datasets-${Environment}`: Pay-per-request billing, `dataset_id` key.
* **Amazon S3**: `datascout-snapshots-...` private bucket with public access block, AES-256 encryption, and 30-day lifecycle rule.
* **Secrets**: Store each external token as the raw `SecretString` of a separate AWS Secrets Manager secret named `datascout/<Environment>/data-govin-api-key` or `datascout/<Environment>/huggingface-api-token`. Pass only the secret ARN using `DataGovInApiSecretArn` or `HuggingFaceApiSecretArn`. Lambda receives secret ARNs, reads values at runtime, and caches them for five minutes. Values are not CloudFormation parameters, Lambda environment values, build arguments, or artifacts.
* **External credentials**: The data.gov.in API key is optional for protected resource details and sample retrieval; public catalog search works without it. The Hugging Face token is optional for higher Hub/viewer limits; gated datasets remain excluded. No AWS service API key or LLM-provider key is required for the current `fake`/`cassette` modes. AWS deployment access is through the AWS CLI profile, not `.env` access keys.
* **Local development only**: `.env` may hold `DATAGOVIN_API_KEY` and `HUGGINGFACE_API_TOKEN` for local use; keep it untracked and never include it in packages. `.env.example` contains only empty placeholders.
* **LLM**: the stack supports `fake` and `cassette` providers.
* **AWS Lambda Functions**:
  * `SearchFunction` (`POST /search` with `datascout-api/search` scope)
  * `ResultsFunction` (`GET /results/{request_id}` with `datascout-api/read` scope)
  * `DatasetFunction` (`GET /dataset/{dataset_id}` with `datascout-api/read` scope)
  * `CompareFunction` (`POST /compare` with `datascout-api/compare` scope)
  * `RefreshFunction` (EventBridge daily rate schedule)

---

## 5. Secrets Manager setup (run once before first deploy)

Create the two Secrets Manager secrets that the Lambda functions will read at
runtime. Do this **before** `sam deploy`. Store only the raw key string as the
secret value (no JSON wrapping).

```powershell
# data.gov.in API key
$DATAGOVIN_SECRET_ARN = (aws secretsmanager create-secret `
  --name datascout/dev/data-govin-api-key `
  --description "DataScout dev – data.gov.in API key" `
  --secret-string "<PASTE_YOUR_DATAGOVIN_KEY_HERE>" `
  --region us-east-1 `
  --query ARN --output text)
Write-Host "DataGovIn Secret ARN: $DATAGOVIN_SECRET_ARN"

# Hugging Face token (optional — leave secret-string as empty string if unused)
$HF_SECRET_ARN = (aws secretsmanager create-secret `
  --name datascout/dev/huggingface-api-token `
  --description "DataScout dev – Hugging Face API token" `
  --secret-string "<PASTE_YOUR_HF_TOKEN_HERE>" `
  --region us-east-1 `
  --query ARN --output text)
Write-Host "HuggingFace Secret ARN: $HF_SECRET_ARN"
```

Copy the two ARN values printed above into your `.env`:
```
DATAGOVIN_API_KEY_SECRET_ARN=arn:aws:secretsmanager:us-east-1:...
HUGGINGFACE_API_TOKEN_SECRET_ARN=arn:aws:secretsmanager:us-east-1:...
```

> To update a secret value in a later lab session (credentials rotate, but the
> secret ARN stays the same):
> ```powershell
> aws secretsmanager put-secret-value `
>   --secret-id datascout/dev/data-govin-api-key `
>   --secret-string "<NEW_KEY>" --region us-east-1
> ```

---

## 6. Deployment commands — run only after explicit approval

> **AWS Academy note**: You cannot create IAM roles. Pass the pre-provisioned
> `LabRole` ARN via `--role-arn` so CloudFormation can create resources.
> Replace `<ACCOUNT_ID>` with your 12-digit account ID from `sts get-caller-identity`.

Deploy the stack (first run — guided):

```powershell
# Get your account ID first:
$ACCOUNT_ID = (aws sts get-caller-identity --query Account --output text)
$LABROLE_ARN = "arn:aws:iam::${ACCOUNT_ID}:role/LabRole"

sam deploy --guided `
  --stack-name datascout-backend-dev `
  --region us-east-1 `
  --resolve-s3 `
  --capabilities CAPABILITY_IAM `
  --role-arn $LABROLE_ARN `
  --parameter-overrides Environment=dev CorsAllowedOrigin="*" `
    DataGovInApiSecretArn="$DATAGOVIN_SECRET_ARN" `
    HuggingFaceApiSecretArn="$HF_SECRET_ARN"
```

For subsequent deployments (save answers from `--guided` in `samconfig.toml`):
```powershell
sam deploy --stack-name datascout-backend-dev --region us-east-1 --resolve-s3 --capabilities CAPABILITY_IAM --role-arn $LABROLE_ARN
```

---

## 7. Retrieving Deployment Outputs

Inspect the deployed outputs to connect the frontend and configure clients:

```powershell
aws cloudformation describe-stacks `
  --stack-name datascout-backend-dev `
  --region us-east-1 `
  --query "Stacks[0].Outputs" `
  --output table
```

Outputs returned:
1. `ApiEndpoint`: The base URL for the deployed REST API (e.g., `https://<api-id>.execute-api.us-east-1.amazonaws.com/dev`).
2. `CognitoUserPoolId`: The user pool identifier.
3. `CognitoUserPoolClientId`: The public SPA client ID.
4. `ResultsTableName`: The DynamoDB results/search-cache table name.
5. `DatasetsTableName`: The DynamoDB normalized dataset detail table name.
6. `SnapshotsBucketName`: The private S3 snapshots bucket name.

Copy these values into `.env` (the `RESULTS_TABLE_NAME=`, `COGNITO_USER_POOL_ID=`, etc. fields).

---

## 8. Verifying Deployed API (Smoke Test)

Verify the deployed protected API endpoints:

```powershell
# 1. Get the API endpoint from stack outputs:
$API_URL = (aws cloudformation describe-stacks `
  --stack-name datascout-backend-dev `
  --region us-east-1 `
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" `
  --output text)
Write-Host "API URL: $API_URL"

# 2. Test unauthenticated (expect 401 with ErrorObject JSON):
Invoke-RestMethod -Uri "$API_URL/search" -Method Post `
  -Body '{"query":"crop yield"}' -ContentType "application/json" `
  -SkipHttpErrorCheck -StatusCodeVariable "code"
Write-Host "Response HTTP Status: $code"  # Should be 401

# 3. Test with Cognito user token (obtain from Cognito initiate-auth or OAuth flow):
$TOKEN = "<COGNITO_ACCESS_TOKEN>"
$Headers = @{
  "Authorization" = "Bearer $TOKEN"
  "Content-Type"  = "application/json"
}
$Body = @{ query = "Indian crop yield dataset for Maharashtra with rainfall" } | ConvertTo-Json
Invoke-RestMethod -Uri "$API_URL/search" -Method Post -Headers $Headers -Body $Body
```

---

## 9. Cleanup & Teardown

To delete all deployed AWS resources and prevent ongoing costs (important in AWS Academy
to avoid burning remaining credits):

```powershell
sam delete --stack-name datascout-backend-dev --region us-east-1

# Also delete the Secrets Manager secrets to stop the per-secret monthly charge:
aws secretsmanager delete-secret `
  --secret-id datascout/dev/data-govin-api-key `
  --force-delete-without-recovery --region us-east-1

aws secretsmanager delete-secret `
  --secret-id datascout/dev/huggingface-api-token `
  --force-delete-without-recovery --region us-east-1
```

> **Tip**: In AWS Academy, credentials expire at session end. Before your next session,
> update `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` in `.env`.
