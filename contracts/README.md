# DataScout contracts

This package is the shared contract surface for all streams. Zod schemas,
inferred TypeScript types, and generated JSON Schema files are derived from the
same definitions in `src/schemas.ts`.

## Usage

Import the named schemas and types from `@datascout/contracts`. Run
`npm run build --workspace=@datascout/contracts` after changing a schema; this
type-checks the package and regenerates `json-schema/*.schema.json`.

## Contract v1 decisions

- `ExtractedRequirements` always has exactly the eight properties listed in
  `docs/plan.md`. Unknown scalar values are `null`; absent list values are
  empty arrays. Extra object properties are rejected.
- Extraction caps are exported constants and are enforced after trimming:
  scalar fields have a 200-character maximum; each extraction array allows at
  most 20 non-empty strings of at most 100 characters; `minimum_records` is
  either `null` or an integer from 1 through 1,000,000,000. Values above a cap
  are rejected, never truncated.
- JSON Schema marks extraction strings with
  `x-trim-before-length-validation: true`, because standard JSON Schema cannot
  trim values itself. Consumers must trim before applying its `maxLength`
  constraints; Zod performs that normalization during runtime validation.
- `Requirement.source_span` is either `null` or `{ start, end, text }`.
  Offsets are zero-based, end-exclusive JavaScript string (UTF-16 code-unit)
  offsets into the original query; the text length must equal `end - start`.
- Dataset provenance is keyed by normalized dataset field and records
  `{ source_field_path, retrieved_at }`. `retrieved_at` is an ISO 8601
  date-time with an explicit timezone.
- `DatasetDetail` carries the dataset, evidence, requirement matches, quality
  checks, access instructions, optional starter code, preprocessing guidance,
  next steps, and complementary dataset suggestions. Every join suggestion
  requires `manual_verification_required: true`.
- `SearchResult.score` is the numeric 0–100 total; `score_breakdown` carries
  the versioned component weights and points. Compare responses repeat these
  values per dataset and never declare a model-authored winner.
- Dataset source identifiers remain non-empty strings to permit future
  adapters. Dataset IDs use the `{source}:{native_id}` pattern in the plan.
- `ExtractedRequirementsSchema` is the strict model-output boundary. Schemas
  do not coerce or truncate invalid values.
- The `POST /search` query is limited to 1,000 characters (trimmed before the
  limit check); this is the API query cap, separate from extraction-field caps.
- Standard JSON Schema cannot express every relational refinement. Runtime
  consumers must validate with the Zod schemas, which additionally enforce
  source-span offset/text consistency, unique compare IDs, and component
  points not exceeding component weights.
