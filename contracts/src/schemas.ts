import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const nullableText = z.string().trim().min(1).nullable();
const textList = z.array(nonEmptyString);
const isoDateTime = z.iso.datetime({ offset: true });

export const EXTRACTION_FIELD_MAX_LENGTH = 200;
export const EXTRACTION_LIST_MAX_ITEMS = 20;
export const EXTRACTION_LIST_ITEM_MAX_LENGTH = 100;
export const MINIMUM_RECORDS_MIN_VALUE = 1;
export const MINIMUM_RECORDS_MAX_VALUE = 1_000_000_000;
export const SEARCH_QUERY_MAX_LENGTH = 1_000;
export const CONTRACT_VERSION = '1.0.0';
export const SCHEMA_VERSION = '1.0.0';

export const DATASET_ID_PATTERN =
  '^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$';

const datasetId = z.string().regex(new RegExp(DATASET_ID_PATTERN));
const recordCount = z.number().int().nonnegative().nullable();
const extractedScalar = z
  .string()
  .trim()
  .min(1)
  .max(EXTRACTION_FIELD_MAX_LENGTH)
  .describe(
    `Trim surrounding whitespace before measuring length; maximum ${EXTRACTION_FIELD_MAX_LENGTH} characters.`,
  )
  .nullable();
const extractedList = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(EXTRACTION_LIST_ITEM_MAX_LENGTH)
      .describe(
        `Trim surrounding whitespace before measuring length; maximum ${EXTRACTION_LIST_ITEM_MAX_LENGTH} characters.`,
      ),
  )
  .max(EXTRACTION_LIST_MAX_ITEMS)
  .describe(
    `Maximum ${EXTRACTION_LIST_MAX_ITEMS} non-empty entries; reject rather than truncate.`,
  );

export const ExtractedRequirementsSchema = z
  .object({
    topic: extractedScalar,
    geography: extractedScalar,
    time_coverage: extractedScalar,
    minimum_records: z
      .number()
      .int()
      .min(MINIMUM_RECORDS_MIN_VALUE)
      .max(MINIMUM_RECORDS_MAX_VALUE)
      .nullable(),
    required_features: extractedList,
    target: extractedScalar,
    preferences: extractedList,
    constraints: extractedList,
  })
  .strict();

export const RequirementTypeSchema = z.enum([
  'topic',
  'geography',
  'time_coverage',
  'minimum_records',
  'feature',
  'target',
  'constraint',
  'preference',
]);

export const RequirementPrioritySchema = z.enum(['required', 'preferred']);

export const SourceSpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    text: nonEmptyString,
  })
  .strict()
  .describe('Zero-based, end-exclusive UTF-16 offsets into the original query.')
  .refine((span) => span.end > span.start, {
    message: 'source span end must be greater than start',
    path: ['end'],
  })
  .refine((span) => span.end - span.start === span.text.length, {
    message: 'source span offsets must match the text length',
    path: ['text'],
  });

export const RequirementSchema = z
  .object({
    requirement_id: nonEmptyString,
    type: RequirementTypeSchema,
    value: z.union([nonEmptyString, z.number().finite()]),
    unit: nullableText,
    priority: RequirementPrioritySchema,
    aliases: textList,
    source_span: SourceSpanSchema.nullable(),
  })
  .strict();

export const VerificationLevelSchema = z.enum([
  'metadata_only',
  'sample_checked',
  'full_dataset',
]);

export const DatasetProvenanceSchema = z
  .object({
    source_field_path: nonEmptyString,
    retrieved_at: isoDateTime,
  })
  .strict();

export const DatasetSchema = z
  .object({
    dataset_id: datasetId,
    source: nonEmptyString,
    source_url: z.url().nullable(),
    title: nullableText,
    description: nullableText,
    license: nullableText,
    access_type: nullableText,
    api_endpoint: z.url().nullable(),
    file_formats: textList,
    record_count: recordCount,
    columns: textList,
    geography: nullableText,
    time_coverage: nullableText,
    tags: textList,
    last_updated: isoDateTime.nullable(),
    retrieved_at: isoDateTime,
    raw_snapshot_key: nullableText,
    verification_level: VerificationLevelSchema,
    provenance: z.record(z.string(), DatasetProvenanceSchema),
  })
  .strict();

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const EvidenceSchema = z
  .object({
    evidence_id: nonEmptyString,
    dataset_id: datasetId,
    field: nonEmptyString,
    value: JsonValueSchema,
    provenance: DatasetProvenanceSchema,
  })
  .strict();

export const RequirementMatchStatusSchema = z.enum([
  'PASS',
  'PARTIAL',
  'FAIL',
  'UNKNOWN',
]);

export const RequirementMatchSchema = z
  .object({
    requirement_id: nonEmptyString,
    status: RequirementMatchStatusSchema,
    reason: nonEmptyString,
    evidence_ids: textList,
    verification_level: VerificationLevelSchema,
    measured_value: JsonValueSchema.optional(),
  })
  .strict();

export const ScoreComponentNameSchema = z.enum([
  'requirement_satisfaction',
  'validation_access',
  'metadata_completeness',
  'license_source_clarity',
  'freshness',
]);

export const ScoreComponentSchema = z
  .object({
    name: ScoreComponentNameSchema,
    weight: z.number().finite().nonnegative(),
    points: z.number().finite().nonnegative(),
  })
  .strict()
  .refine((component) => component.points <= component.weight, {
    message: 'component points cannot exceed its weight',
    path: ['points'],
  });

export const ScoreBreakdownSchema = z
  .object({
    scoring_version: nonEmptyString,
    total: z.number().finite().min(0).max(100),
    components: z.array(ScoreComponentSchema),
    evidence_coverage: z.number().finite().min(0).max(1),
  })
  .strict();

export const ContractVersionsSchema = z
  .object({
    contract_version: nonEmptyString,
    prompt_version: nonEmptyString,
    schema_version: nonEmptyString,
    scoring_version: nonEmptyString,
    model_id: nonEmptyString,
  })
  .strict();

export const SourceStatusSchema = z
  .object({
    source: nonEmptyString,
    status: z.enum(['success', 'partial', 'failed', 'disabled']),
    result_count: z.number().int().nonnegative(),
    warning: nullableText,
  })
  .strict();

export const QualityCheckSchema = z
  .object({
    check: nonEmptyString,
    status: z.enum(['PASS', 'PARTIAL', 'FAIL', 'NOT_CHECKED']),
    summary: nonEmptyString,
    evidence_ids: textList,
  })
  .strict();

export const SearchResultSchema = z
  .object({
    dataset_id: datasetId,
    score: z.number().finite().min(0).max(100),
    score_breakdown: ScoreBreakdownSchema,
    matches: z.array(RequirementMatchSchema),
    evidence: z.array(EvidenceSchema),
    quality_checks: z.array(QualityCheckSchema),
    verification_level: VerificationLevelSchema,
    warnings: textList,
    explanation: nullableText,
  })
  .strict();

export const SearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH),
    options: z
      .object({
        sources: textList.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SearchResponseSchema = z
  .object({
    request_id: nonEmptyString,
    requirements: ExtractedRequirementsSchema,
    source_statuses: z.array(SourceStatusSchema),
    results: z.array(SearchResultSchema),
    warnings: textList,
    ...ContractVersionsSchema.shape,
  })
  .strict();

export const CompareRequestSchema = z
  .object({
    dataset_ids: z.array(datasetId).min(2).max(4),
  })
  .strict()
  .describe('Compare two to four unique, known public dataset IDs.')
  .refine(
    (request) =>
      new Set(request.dataset_ids).size === request.dataset_ids.length,
    {
      message: 'dataset_ids must not contain duplicates',
      path: ['dataset_ids'],
    },
  );

export const CompareDatasetSchema = z
  .object({
    dataset: DatasetSchema,
    evidence: z.array(EvidenceSchema),
    matches: z.array(RequirementMatchSchema),
    score: z.number().finite().min(0).max(100),
    score_breakdown: ScoreBreakdownSchema,
  })
  .strict();

export const CompareResponseSchema = z
  .object({
    datasets: z.array(CompareDatasetSchema).min(2).max(4),
    ...ContractVersionsSchema.shape,
  })
  .strict();

export const ComplementaryDatasetSuggestionSchema = z
  .object({
    dataset_id: datasetId,
    reason: nonEmptyString,
    join_keys: textList,
    manual_verification_required: z.literal(true),
  })
  .strict();

export const DatasetDetailSchema = z
  .object({
    dataset: DatasetSchema,
    evidence: z.array(EvidenceSchema),
    matches: z.array(RequirementMatchSchema),
    quality_checks: z.array(QualityCheckSchema),
    access_instructions: textList,
    starter_code: nullableText,
    preprocessing: textList,
    next_steps: textList,
    complementary_datasets: z.array(ComplementaryDatasetSuggestionSchema),
    ...ContractVersionsSchema.shape,
  })
  .strict();

export const ErrorObjectSchema = z
  .object({
    code: nonEmptyString,
    message: nonEmptyString,
    request_id: nonEmptyString,
    retryable: z.boolean().optional(),
    ...ContractVersionsSchema.shape,
  })
  .strict();

export type ExtractedRequirements = z.infer<typeof ExtractedRequirementsSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Dataset = z.infer<typeof DatasetSchema>;
export type DatasetProvenance = z.infer<typeof DatasetProvenanceSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type RequirementMatch = z.infer<typeof RequirementMatchSchema>;
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;
export type ContractVersions = z.infer<typeof ContractVersionsSchema>;
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
export type QualityCheck = z.infer<typeof QualityCheckSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type CompareRequest = z.infer<typeof CompareRequestSchema>;
export type CompareDataset = z.infer<typeof CompareDatasetSchema>;
export type CompareResponse = z.infer<typeof CompareResponseSchema>;
export type ComplementaryDatasetSuggestion = z.infer<
  typeof ComplementaryDatasetSuggestionSchema
>;
export type DatasetDetail = z.infer<typeof DatasetDetailSchema>;
export type ErrorObject = z.infer<typeof ErrorObjectSchema>;
