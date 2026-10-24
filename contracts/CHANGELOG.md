# Contract changelog

## 1.0.0

- Initial shared schemas for requirement extraction, requirements, datasets,
  evidence, matches, scores, source statuses, search, compare, dataset detail,
  and API errors.
- Freeze extraction caps: 200 characters per scalar, 20 entries per extracted
  array, 100 characters per array entry, and `minimum_records` from 1 through
  1,000,000,000. Whitespace is trimmed before size validation; over-cap values
  and empty array entries are rejected and never truncated.
- These caps are part of contract v1. Future contract versions may raise them,
  but must never lower them.
- `Requirement.source_span` uses zero-based, end-exclusive UTF-16 offsets with
  the matched source text.
- Dataset provenance records the source field path and ISO 8601 retrieval time.
- `POST /search` query length is limited to 1,000 characters after trimming;
  this API request cap is separate from the extraction-field caps.
