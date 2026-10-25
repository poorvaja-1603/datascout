import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  SearchRequestSchema,
  SearchResponseSchema,
  DatasetDetailSchema,
  SEARCH_QUERY_MAX_LENGTH,
  createClarification,
  createRefusal,
} from '@datascout/contracts';
import type {
  CallContext,
  Dataset,
  Evidence,
  SampleInspection,
  SourceStatus,
} from '@datascout/contracts';
import {
  createExplanationService,
  createLlmClient,
  createRequestSafetyCheck,
  createRequirementExtractor,
  loadLlmConfig,
} from '@datascout/ai';
import {
  DataGovInConnector,
  HuggingFaceConnector,
} from '@datascout/connectors';
import { createScorer } from '@datascout/verify';
import { createLangfuseTracer } from '@datascout/observability';
import { loadRuntimeSecret } from '../secrets.js';
import { DynamoDbCatalogStore } from '../storage/catalog-store.js';
import {
  extractContextInfo,
  jsonResponse,
  errorResponse,
} from '../utils/http.js';
import {
  getResultsStore,
  getDatasetsStore,
  DEFAULT_RESULTS_TTL_SECONDS,
} from '../storage/index.js';

const versions = {
  contract_version: process.env.CONTRACT_VERSION ?? '1.0.0',
  prompt_version: process.env.PROMPT_VERSION ?? 'extract-v1',
  schema_version: process.env.SCHEMA_VERSION ?? '1.0.0',
  scoring_version: process.env.SCORING_VERSION ?? 'score-v1',
  model_id: process.env.MODEL_ID ?? 'fake-datascout-v0.1',
};

function sourceEvidence(dataset: Dataset): Evidence[] {
  const values: Record<string, unknown> = {
    title: dataset.title,
    description: dataset.description,
    license: dataset.license,
    access_type: dataset.access_type,
    file_formats: dataset.file_formats,
    record_count: dataset.record_count,
    columns: dataset.columns,
    geography: dataset.geography,
    time_coverage: dataset.time_coverage,
    tags: dataset.tags,
  };
  return Object.entries(dataset.provenance).flatMap(([field, provenance]) => {
    if (!(field in values) || values[field] === null) return [];
    return [
      {
        evidence_id: `${dataset.dataset_id}:metadata:${field}`,
        dataset_id: dataset.dataset_id,
        field,
        value: values[field] as Evidence['value'],
        provenance,
      },
    ];
  });
}

function createContext(requestId: string, timeoutMs: number): CallContext {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Lambda freezes the process after invocation; unref avoids holding local runs open.
  timer.unref?.();
  const tracer = createLangfuseTracer();
  return {
    requestId,
    signal: controller.signal,
    deadlineMs: Date.now() + timeoutMs,
    tracer,
  };
}

function boundedSetting(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  return Math.min(max, Math.max(min, Number(raw)));
}

async function runSearch(
  query: string,
  requestId: string,
  requestedSources?: string[],
) {
  const ctx = createContext(
    requestId,
    Number(process.env.SEARCH_TIMEOUT_MS ?? 25_000),
  );
  try {
    const llmConfig = loadLlmConfig(process.env);
    const llm = createLlmClient(llmConfig);
    const extractor = createRequirementExtractor(
      llm,
      createRequestSafetyCheck(),
    );
    const extracted = await extractor.extract(query, ctx);
    if (extracted.kind === 'clarification') {
      return {
        request_id: requestId,
        outcome: 'clarification_needed' as const,
        requirements: {
          topic: null,
          geography: null,
          time_coverage: null,
          minimum_records: null,
          required_features: [],
          target: null,
          preferences: [],
          constraints: [],
        },
        clarification: extracted.question
          ? { reason_code: 'too_vague' as const, question: extracted.question }
          : createClarification('too_vague'),
        source_statuses: [],
        results: [],
        warnings: [],
        ...versions,
      };
    }
    if (extracted.kind === 'refused') {
      return {
        request_id: requestId,
        outcome: 'refused' as const,
        requirements: null,
        refusal: createRefusal(
          extracted.reasonCode as Parameters<typeof createRefusal>[0],
        ),
        source_statuses: [],
        results: [],
        warnings: [],
        ...versions,
      };
    }

    let catalog: Awaited<ReturnType<DynamoDbCatalogStore['listSource']>> = [];
    let catalogUnavailable = false;
    try {
      catalog = await new DynamoDbCatalogStore().listSource(
        'datagovin',
        Number(process.env.CATALOG_SEARCH_LIMIT ?? 1000),
      );
    } catch {
      catalogUnavailable = true;
    }
    const wantsHuggingFace =
      !requestedSources?.length || requestedSources.includes('huggingface');
    const wantsDataGovIn =
      !requestedSources?.length || requestedSources.includes('datagovin');
    const [huggingFaceToken, dataGovInKey] = await Promise.all([
      wantsHuggingFace
        ? loadRuntimeSecret(
            'HUGGINGFACE_API_TOKEN_SECRET_ARN',
            'HUGGINGFACE_API_TOKEN',
          )
        : undefined,
      wantsDataGovIn
        ? loadRuntimeSecret('DATAGOVIN_API_KEY_SECRET_ARN', 'DATAGOVIN_API_KEY')
        : undefined,
    ]);
    const huggingFace = new HuggingFaceConnector(
      huggingFaceToken ? { apiToken: huggingFaceToken } : {},
    );
    const dataGovIn = new DataGovInConnector({
      ...(dataGovInKey ? { apiKey: dataGovInKey } : {}),
      cachedCatalog: catalog,
    });
    const connectors = [huggingFace, dataGovIn].filter(
      (connector) =>
        !requestedSources?.length ||
        requestedSources.includes(connector.source),
    );
    const searchRequest = {
      requirements: extracted.requirements,
      derived: extracted.derived,
      maxResults: 10,
    };
    const statuses: SourceStatus[] = [];
    const candidates: Dataset[] = [];
    await Promise.all(
      connectors.map(async (connector) => {
        try {
          const result = await connector.search(searchRequest, ctx);
          statuses.push(result.status);
          candidates.push(...result.datasets);
        } catch {
          statuses.push({
            source: connector.source,
            status: 'failed',
            result_count: 0,
            warning: 'Source request failed.',
          });
        }
      }),
    );
    if (connectors.some((connector) => connector.source === 'datagovin')) {
      const dataGovStatus = statuses.find(
        (item) => item.source === 'datagovin',
      );
      if (catalogUnavailable && dataGovStatus) {
        dataGovStatus.status = 'failed';
        dataGovStatus.warning =
          'The harvested catalog index could not be loaded.';
      }
      try {
        const refresh = await new DynamoDbCatalogStore().getRefreshStatus(
          'datagovin',
        );
        if (refresh && refresh.status !== 'success') {
          const indexStatus = statuses.find(
            (item) => item.source === 'datagovin',
          );
          if (indexStatus) {
            const note =
              refresh.warning ??
              `Last catalog refresh was ${refresh.status} at ${refresh.timestamp}.`;
            indexStatus.warning = [indexStatus.warning, note]
              .filter(Boolean)
              .join(' ');
            if (indexStatus.status === 'success')
              indexStatus.status = 'partial';
          }
        }
      } catch {
        // Refresh-status lookup is advisory and cannot fail an otherwise healthy search.
      }
    }
    const unique = [
      ...new Map(candidates.map((d) => [d.dataset_id, d])).values(),
    ]
      .sort((left, right) => left.dataset_id.localeCompare(right.dataset_id))
      .slice(0, boundedSetting('SEARCH_MAX_CANDIDATES', 10, 1, 20));
    const scorer = createScorer();
    const limits = {
      maxBytes: boundedSetting(
        'INSPECTION_MAX_BYTES',
        2 * 1024 * 1024,
        1024,
        5 * 1024 * 1024,
      ),
      maxRows: boundedSetting('INSPECTION_MAX_ROWS', 500, 1, 1000),
      maxColumns: boundedSetting('INSPECTION_MAX_COLUMNS', 100, 1, 100),
      timeoutMs: boundedSetting('INSPECTION_TIMEOUT_MS', 3000, 100, 5000),
    };
    const inspections = new Map<string, SampleInspection>();
    for (let start = 0; start < unique.length; start += 3) {
      await Promise.all(
        unique.slice(start, start + 3).map(async (dataset) => {
          const sample =
            dataset.source === 'huggingface'
              ? await huggingFace.inspectSample(dataset, limits, ctx)
              : await dataGovIn.inspectSample(dataset, limits, ctx);
          inspections.set(dataset.dataset_id, sample);
        }),
      );
    }
    statuses.sort((left, right) => left.source.localeCompare(right.source));
    const scored = unique.map((candidate) => {
      const inspection = inspections.get(candidate.dataset_id);
      const dataset =
        inspection?.verificationLevel === 'sample_checked'
          ? { ...candidate, verification_level: 'sample_checked' as const }
          : candidate;
      const evidence = [
        ...sourceEvidence(dataset),
        ...(inspection?.evidence ?? []),
      ];
      const scored = scorer.evaluate({
        requirements: extracted.derived,
        dataset,
        ...(inspection ? { inspection: { ...inspection, evidence } } : {}),
      });
      return { ...scored, evidence };
    });
    const ranked = scorer.rank(scored);
    let explanations = new Map<string, string>();
    try {
      const explained = await createExplanationService(llm).explain(
        ranked,
        ctx,
      );
      explanations = new Map(
        explained.map((item) => [
          item.datasetId,
          item.status === 'ok' ? (item.claims[0]?.text ?? '') : '',
        ]),
      );
    } catch {
      // Explanation is optional; deterministic matches and scores remain usable.
    }
    const datasetsStore = getDatasetsStore();
    await Promise.all(
      ranked.map(({ dataset, score, matches, evidence }) => {
        const inspection = inspections.get(dataset.dataset_id);
        const qualityChecks = [
          {
            check: 'sample_inspection',
            status:
              inspection?.verificationLevel === 'sample_checked'
                ? ('PASS' as const)
                : ('NOT_CHECKED' as const),
            summary:
              inspection?.verificationLevel === 'sample_checked'
                ? `Inspected ${inspection.rowsExamined} bounded sample rows.`
                : `Sample inspection unavailable (${inspection?.status ?? 'not attempted'}); metadata only.`,
            evidence_ids:
              inspection?.evidence.map((item) => item.evidence_id) ?? [],
          },
        ];
        return datasetsStore.putDataset(
          DatasetDetailSchema.parse({
            dataset,
            evidence,
            matches,
            quality_checks: qualityChecks,
            access_instructions: dataset.api_endpoint
              ? [`Use the source API: ${dataset.api_endpoint}`]
              : ['Open the source page for access instructions.'],
            starter_code: null,
            preprocessing: [
              'Verify column types, missingness, and date formats before analysis.',
            ],
            next_steps: ['Review the source record and license before use.'],
            complementary_datasets: [],
            ...versions,
          }),
          score.components.reduce(
            (total, component) => total + component.points,
            0,
          ),
          score,
        );
      }),
    );
    const response = {
      request_id: requestId,
      outcome: 'results' as const,
      requirements: extracted.requirements,
      source_statuses: statuses,
      results: ranked.map(({ dataset, score, matches, evidence }) => {
        const inspection = inspections.get(dataset.dataset_id);
        return {
          dataset_id: dataset.dataset_id,
          score: score.components.reduce(
            (total, component) => total + component.points,
            0,
          ),
          score_breakdown: score,
          matches,
          evidence,
          quality_checks: [
            {
              check: 'sample_inspection',
              status:
                inspection?.verificationLevel === 'sample_checked'
                  ? ('PASS' as const)
                  : ('NOT_CHECKED' as const),
              summary:
                inspection?.verificationLevel === 'sample_checked'
                  ? `Inspected ${inspection.rowsExamined} bounded sample rows.`
                  : `Sample inspection unavailable (${inspection?.status ?? 'not attempted'}); metadata only.`,
              evidence_ids:
                inspection?.evidence.map((item) => item.evidence_id) ?? [],
            },
          ],
          verification_level: dataset.verification_level,
          warnings: [],
          explanation: explanations.get(dataset.dataset_id) || null,
        };
      }),
      warnings: [],
      ...versions,
    };
    return SearchResponseSchema.parse(response);
  } finally {
    await ctx.tracer.flush(250).catch(() => undefined);
  }
}

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const { requestId, sub } = extractContextInfo(event);

  // Requirement: return 401 unauthorized when sub is null, before doing any work
  if (!sub) {
    return errorResponse(
      'unauthorized',
      'User identity required to perform search.',
      requestId,
    );
  }

  if (!event.body) {
    return errorResponse('invalid_request', 'Missing request body.', requestId);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(event.body);
  } catch {
    return errorResponse(
      'invalid_request',
      'Malformed JSON in request body.',
      requestId,
    );
  }

  // Parse body with SearchRequestSchema first and map overlength query without casts
  const parseResult = SearchRequestSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    const isOverlengthQuery = parseResult.error.issues.some(
      (issue) => issue.path[0] === 'query' && issue.code === 'too_big',
    );
    if (isOverlengthQuery) {
      return errorResponse(
        'payload_too_large',
        `Search query exceeds maximum allowed length of ${SEARCH_QUERY_MAX_LENGTH} characters.`,
        requestId,
      );
    }

    const issue =
      parseResult.error.issues[0]?.message ?? 'Invalid search request schema.';
    return errorResponse('invalid_request', issue, requestId);
  }

  let validatedResponse;
  try {
    validatedResponse = await runSearch(
      parseResult.data.query,
      requestId,
      parseResult.data.options?.sources,
    );
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : '';
    if (code === 'timeout' || code === 'llm_timeout') {
      return errorResponse(
        'timeout',
        'Search exceeded its time limit.',
        requestId,
      );
    }
    if (code === 'extraction_failed') {
      return errorResponse(
        'extraction_failed',
        'Requirements could not be extracted safely.',
        requestId,
      );
    }
    console.error(
      JSON.stringify({
        event: 'search_failed',
        request_id: requestId,
        error_code: code || 'internal_error',
      }),
    );
    return errorResponse(
      'upstream_unavailable',
      'Search sources are temporarily unavailable.',
      requestId,
    );
  }

  // Store response with caller's sub and TTL from env var
  const envTtl = parseInt(process.env.RESULTS_TTL_SECONDS || '', 10);
  const ttlSeconds =
    Number.isInteger(envTtl) && envTtl > 0
      ? envTtl
      : DEFAULT_RESULTS_TTL_SECONDS;

  const resultsStore = getResultsStore();
  await resultsStore.putResult(
    validatedResponse.request_id,
    sub,
    validatedResponse,
    ttlSeconds,
  );

  return jsonResponse(200, validatedResponse);
}
