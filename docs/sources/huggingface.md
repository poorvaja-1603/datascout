# Source Note: Hugging Face Datasets

## Integration Overview
* **Candidate Discovery**: Uses Hugging Face Hub API (`https://huggingface.co/api/datasets?search=...&limit=...&full=true`).
* **Schema and Quality Inspection**: Uses Dataset Viewer API (`https://datasets-server.huggingface.co/info` and `/rows`).
* **Format**: Parquet, Arrow, CSV, JSON.

## Boundaries and Security Rules
1. **No Code Execution**: Never run Python loading scripts (`datasets.load_dataset()`) or set `trust_remote_code=True`.
2. **Access Control**: Gated datasets and private repositories are skipped.
3. **Viewer Availability**: Dataset Viewer API availability varies per dataset. If viewer endpoints return 404 or 503, the adapter gracefully falls back to `metadata_only` verification.
4. **Rate Limits**: Hub API rate limits (HTTP 429) trigger exponential backoff.
