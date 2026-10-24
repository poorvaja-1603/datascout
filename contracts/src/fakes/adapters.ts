import {
  DATASCOUT_ERROR_CODES,
  DataScoutError,
  throwIfAborted,
} from '../errors.js';
import type {
  CallContext,
  Connector,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  ExplanationResult,
  ExplanationService,
  ExtractionResult,
  InspectionLimits,
  Inspector,
  RequirementExtractor,
  SampleInspection,
  ScoredDataset,
  SourceId,
} from '../ports.js';
import type {
  Dataset,
  ExtractedRequirements,
  Requirement,
} from '../schemas.js';
import type { SourceStatus } from '../schemas.js';
import { DEMO_EXTRACTION_CASES } from './fake-llm-client.js';

function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

function requireFixture<T>(fixture: T | undefined, description: string): T {
  if (fixture === undefined) {
    throw new DataScoutError(
      DATASCOUT_ERROR_CODES.fixtureNotFound,
      `No ${description} fixture was found.`,
      false,
    );
  }
  return structuredClone(fixture);
}

function requirementTypeFor(field: string): Requirement['type'] {
  switch (field) {
    case 'topic':
    case 'geography':
    case 'time_coverage':
    case 'minimum_records':
    case 'target':
    case 'constraint':
    case 'preference':
    case 'feature':
      return field;
    case 'required_features':
      return 'feature';
    case 'constraints':
      return 'constraint';
    case 'preferences':
      return 'preference';
    default:
      throw new Error(`Unsupported fake requirement field: ${field}`);
  }
}

function deriveRequirements(
  query: string,
  requirements: ExtractedRequirements,
): Requirement[] {
  const fields: {
    field: string;
    values: Array<string | number>;
  }[] = [
    { field: 'topic', values: requirements.topic ? [requirements.topic] : [] },
    {
      field: 'geography',
      values: requirements.geography ? [requirements.geography] : [],
    },
    {
      field: 'time_coverage',
      values: requirements.time_coverage ? [requirements.time_coverage] : [],
    },
    {
      field: 'minimum_records',
      values:
        requirements.minimum_records === null
          ? []
          : [requirements.minimum_records],
    },
    { field: 'required_features', values: requirements.required_features },
    {
      field: 'target',
      values: requirements.target ? [requirements.target] : [],
    },
    { field: 'preferences', values: requirements.preferences },
    { field: 'constraints', values: requirements.constraints },
  ];

  const typeCounters = new Map<Requirement['type'], number>();
  return fields.flatMap(({ field, values }) =>
    values.map((value) => {
      const type = requirementTypeFor(field);
      const index = (typeCounters.get(type) ?? 0) + 1;
      typeCounters.set(type, index);
      const matchIndex =
        typeof value === 'string'
          ? query.toLocaleLowerCase().indexOf(value.toLocaleLowerCase())
          : query.indexOf(String(value));
      const sourceText =
        matchIndex < 0
          ? null
          : query.slice(matchIndex, matchIndex + String(value).length);

      return {
        requirement_id: `fake-${type}-${index}`,
        type,
        value,
        unit: null,
        priority: field === 'preferences' ? 'preferred' : 'required',
        aliases: [],
        source_span:
          sourceText === null
            ? null
            : {
                start: matchIndex,
                end: matchIndex + sourceText.length,
                text: sourceText,
              },
      };
    }),
  );
}

export class FakeExtractor implements RequirementExtractor {
  private readonly fixtures: readonly {
    input: string;
    result: ExtractionResult;
  }[];

  constructor(
    fixtures: readonly {
      input: string;
      result: ExtractionResult;
    }[] = createDemoExtractionFixtures(),
  ) {
    this.fixtures = structuredClone(fixtures);
  }

  async extract(query: string, ctx: CallContext) {
    throwIfAborted(ctx.signal);
    const fixture = this.fixtures.find(
      ({ input }) => normalizeWhitespace(input) === normalizeWhitespace(query),
    );
    if (!fixture) {
      throw new DataScoutError(
        DATASCOUT_ERROR_CODES.fakeNoCannedResponse,
        'FakeExtractor has no canned response for this input.',
        false,
      );
    }

    throwIfAborted(ctx.signal);
    return structuredClone(fixture.result);
  }
}

function createDemoExtractionFixtures(): {
  input: string;
  result: ExtractionResult;
}[] {
  return DEMO_EXTRACTION_CASES.map(({ input, expected }) => {
    const requirements = structuredClone(expected);
    const result: ExtractionResult =
      requirements.topic === null
        ? {
            kind: 'clarification',
            question: 'What kind of dataset does your project need?',
          }
        : {
            kind: 'ok',
            requirements,
            derived: deriveRequirements(input, requirements),
            promptVersion: 'fake-v1',
            modelId: 'fake-datascout-v0.1',
          };
    return { input, result };
  });
}

export class FixtureConnector implements Connector {
  readonly source: SourceId;
  private readonly datasets: Dataset[];
  private readonly sourceStatus: SourceStatus;

  constructor(
    source: SourceId,
    datasets: readonly Dataset[],
    sourceStatus?: SourceStatus,
  ) {
    this.source = source;
    this.datasets = datasets.map((dataset) => structuredClone(dataset));
    this.sourceStatus = structuredClone(
      sourceStatus ?? {
        source,
        status: 'success',
        result_count: datasets.length,
        warning: null,
      },
    );
  }

  async search(
    req: ConnectorSearchRequest,
    ctx: CallContext,
  ): Promise<ConnectorSearchResult> {
    throwIfAborted(ctx.signal);
    if (!Number.isInteger(req.maxResults) || req.maxResults < 0) {
      throw new DataScoutError(
        DATASCOUT_ERROR_CODES.invalidConnectorRequest,
        'maxResults must be a non-negative integer.',
        false,
      );
    }
    const datasets = structuredClone(this.datasets.slice(0, req.maxResults));
    throwIfAborted(ctx.signal);
    return {
      source: this.source,
      status: {
        ...this.sourceStatus,
        source: this.source,
        result_count: datasets.length,
      },
      datasets,
    };
  }

  async getDetails(
    datasetId: string,
    ctx: CallContext,
  ): Promise<Dataset | null> {
    throwIfAborted(ctx.signal);
    const dataset = this.datasets.find(
      ({ dataset_id }) => dataset_id === datasetId,
    );
    throwIfAborted(ctx.signal);
    return dataset === undefined ? null : structuredClone(dataset);
  }
}

export class FakeInspector implements Inspector {
  private readonly inspections: SampleInspection[];

  constructor(inspections: readonly SampleInspection[]) {
    this.inspections = inspections.map((inspection) =>
      structuredClone(inspection),
    );
  }

  async inspect(
    dataset: Dataset,
    _limits: InspectionLimits,
    ctx: CallContext,
  ): Promise<SampleInspection> {
    throwIfAborted(ctx.signal);
    return requireFixture(
      this.inspections.find(
        ({ datasetId }) => datasetId === dataset.dataset_id,
      ),
      `inspection for ${dataset.dataset_id}`,
    );
  }
}

export class FakeExplainer implements ExplanationService {
  private readonly explanations: ExplanationResult[];

  constructor(explanations: readonly ExplanationResult[]) {
    this.explanations = explanations.map((explanation) =>
      structuredClone(explanation),
    );
  }

  async explain(
    items: ScoredDataset[],
    ctx: CallContext,
  ): Promise<ExplanationResult[]> {
    throwIfAborted(ctx.signal);
    const explanations = items.map((item) => {
      const explanation = this.explanations.find(
        ({ datasetId }) => datasetId === item.dataset.dataset_id,
      );
      return explanation === undefined
        ? {
            datasetId: item.dataset.dataset_id,
            status: 'unavailable' as const,
            claims: [],
            nextSteps: [],
            preprocessing: [],
          }
        : structuredClone(explanation);
    });
    throwIfAborted(ctx.signal);
    return explanations;
  }
}
