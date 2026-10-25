import type {
  Dataset,
  ErrorObject,
  Evidence,
  ExtractedRequirements,
  Requirement,
  RequirementMatch,
  ScoreBreakdown,
  SourceStatus,
} from './schemas.js';

export type SourceId =
  | 'datagovin'
  | 'huggingface'
  | 'openml'
  | 'worldbank'
  | 'uci'
  | 'zenodo'
  | 'dataverse'
  | 'ckan';

export interface CallContext {
  requestId: string;
  principalId?: string;
  signal: AbortSignal;
  deadlineMs: number;
  tracer: Tracer;
}

export interface LlmJsonRequest {
  task: 'extract' | 'explain' | 'safety_triage';
  modelId?: string;
  promptVersion: string;
  system: string;
  user: string;
  jsonSchema: object;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface LlmJsonResponse {
  output: unknown;
  modelId: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export interface LlmClient {
  readonly provider: 'fake' | 'cassette' | 'gemini' | 'ollama';
  readonly modelId: string;
  readonly safetyModelId?: string | undefined;
  readonly maxProviderCallsPerRequest?: number | undefined;
  generateJson(req: LlmJsonRequest, ctx: CallContext): Promise<LlmJsonResponse>;
}

export type ExtractionResult =
  | {
      kind: 'ok';
      requirements: ExtractedRequirements;
      derived: Requirement[];
      promptVersion: string;
      modelId: string;
    }
  | { kind: 'clarification'; question: string }
  | { kind: 'refused'; reasonCode: string };

export interface RequirementExtractor {
  extract(query: string, ctx: CallContext): Promise<ExtractionResult>;
}

export interface ConnectorSearchRequest {
  requirements: ExtractedRequirements;
  derived: Requirement[];
  maxResults: number;
}

export interface ConnectorSearchResult {
  source: SourceId;
  status: SourceStatus;
  datasets: Dataset[];
}

export interface Connector {
  readonly source: SourceId;
  search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult>;
  getDetails(datasetId: string, ctx: CallContext): Promise<Dataset | null>;
}

export interface InspectionLimits {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  timeoutMs: number;
}

export interface SampleInspection {
  datasetId: string;
  status: 'ok' | 'unsupported_format' | 'too_large' | 'blocked' | 'failed';
  verificationLevel: 'metadata_only' | 'sample_checked';
  rowsExamined: number;
  columns: {
    name: string;
    inferredType: string;
    missingRate: number | null;
  }[];
  dateRange: { start: string; end: string } | null;
  duplicateRate: number | null;
  evidence: Evidence[];
}

export interface Inspector {
  inspect(
    dataset: Dataset,
    limits: InspectionLimits,
    ctx: CallContext,
  ): Promise<SampleInspection>;
}

export interface ScoredDataset {
  dataset: Dataset;
  matches: RequirementMatch[];
  score: ScoreBreakdown;
  evidence: Evidence[];
}

export interface Scorer {
  readonly scoringVersion: string;
  evaluate(input: {
    requirements: Requirement[];
    dataset: Dataset;
    inspection?: SampleInspection;
  }): ScoredDataset;
  rank(items: ScoredDataset[]): ScoredDataset[];
}

export interface ExplanationResult {
  datasetId: string;
  status: 'ok' | 'unavailable';
  claims: { text: string; evidenceIds: string[] }[];
  nextSteps: string[];
  preprocessing: string[];
}

export interface ExplanationService {
  explain(
    items: ScoredDataset[],
    ctx: CallContext,
  ): Promise<ExplanationResult[]>;
}

export interface SpanHandle {
  setAttributes(attrs: Record<string, string | number | boolean>): void;
  setGenerationDetails?(details: {
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }): void;
  score(name: string, value: number | boolean, comment?: string): void;
}

export interface Tracer {
  withSpan<T>(
    name: string,
    opts: { kind: 'span' | 'generation' },
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T>;
  flush(timeoutMs: number): Promise<void>;
}

export type DataScoutErrorCode = ErrorObject['code'];
