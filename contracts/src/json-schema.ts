import { z } from 'zod';
import {
  ComplementaryDatasetSuggestionSchema,
  CompareRequestSchema,
  CompareDatasetSchema,
  CompareResponseSchema,
  ContractVersionsSchema,
  DatasetProvenanceSchema,
  DatasetDetailSchema,
  DatasetSchema,
  ErrorObjectSchema,
  EvidenceSchema,
  ExtractedRequirementsSchema,
  QualityCheckSchema,
  RequirementPrioritySchema,
  RequirementTypeSchema,
  RequirementMatchSchema,
  RequirementMatchStatusSchema,
  RequirementSchema,
  ScoreComponentNameSchema,
  ScoreComponentSchema,
  ScoreBreakdownSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SearchResultSchema,
  SourceSpanSchema,
  SourceStatusSchema,
  VerificationLevelSchema,
} from './schemas.js';

export const jsonSchemas = {
  ExtractedRequirements: ExtractedRequirementsSchema,
  RequirementType: RequirementTypeSchema,
  RequirementPriority: RequirementPrioritySchema,
  SourceSpan: SourceSpanSchema,
  Requirement: RequirementSchema,
  VerificationLevel: VerificationLevelSchema,
  DatasetProvenance: DatasetProvenanceSchema,
  Dataset: DatasetSchema,
  Evidence: EvidenceSchema,
  RequirementMatchStatus: RequirementMatchStatusSchema,
  RequirementMatch: RequirementMatchSchema,
  ScoreComponentName: ScoreComponentNameSchema,
  ScoreComponent: ScoreComponentSchema,
  ScoreBreakdown: ScoreBreakdownSchema,
  ContractVersions: ContractVersionsSchema,
  SourceStatus: SourceStatusSchema,
  QualityCheck: QualityCheckSchema,
  SearchRequest: SearchRequestSchema,
  SearchResult: SearchResultSchema,
  SearchResponse: SearchResponseSchema,
  CompareRequest: CompareRequestSchema,
  CompareDataset: CompareDatasetSchema,
  CompareResponse: CompareResponseSchema,
  ComplementaryDatasetSuggestion: ComplementaryDatasetSuggestionSchema,
  DatasetDetail: DatasetDetailSchema,
  ErrorObject: ErrorObjectSchema,
} satisfies Record<string, z.ZodType>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function markTrimBeforeLengthValidation(schema: unknown): void {
  const record = asRecord(schema);
  if (!record || record.type !== 'string') {
    throw new Error(
      'Expected a string schema when annotating extraction trim behavior.',
    );
  }
  record['x-trim-before-length-validation'] = true;
}

export function toJsonSchemas(): Record<string, unknown> {
  const schemas: Record<string, unknown> = Object.fromEntries(
    Object.entries(jsonSchemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, {
        target: 'draft-2020-12',
        io: 'input',
      }),
    ]),
  );

  const extractionProperties = asRecord(
    asRecord(schemas.ExtractedRequirements)?.properties,
  );
  if (!extractionProperties) {
    throw new Error(
      'Generated ExtractedRequirements schema has no properties.',
    );
  }

  for (const field of ['topic', 'geography', 'time_coverage', 'target']) {
    const property = asRecord(extractionProperties[field]);
    const variants = property?.anyOf;
    if (!Array.isArray(variants)) {
      throw new Error(
        `Generated nullable string schema is missing anyOf for ${field}.`,
      );
    }
    const stringVariant = variants.find(
      (variant) => asRecord(variant)?.type === 'string',
    );
    markTrimBeforeLengthValidation(stringVariant);
  }

  for (const field of ['required_features', 'preferences', 'constraints']) {
    const property = asRecord(extractionProperties[field]);
    const items = asRecord(property?.items);
    markTrimBeforeLengthValidation(items);
  }

  return schemas;
}
