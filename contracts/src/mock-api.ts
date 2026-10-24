import { createServer } from '@msw/serve';
import { http, HttpResponse } from 'msw';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CompareRequestSchema,
  CompareResponseSchema,
  DatasetDetailSchema,
  ERROR_HTTP_STATUS,
  ErrorCodeSchema,
  ErrorObjectSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  type ErrorCode,
  type ErrorObject,
} from './schemas.js';

const fixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures',
);
const searchExampleNames = [
  'search-results',
  'search-partial',
  'search-no-match',
  'search-clarification',
  'search-refused',
] as const;
const mockTokens = new Map<string, readonly string[]>([
  ['mock-access-token', ['search', 'read', 'compare']],
  ['mock-search-token', ['search']],
  ['mock-read-token', ['read']],
  ['mock-compare-token', ['compare']],
]);

type SearchExampleName = (typeof searchExampleNames)[number];
type SearchExamples = Map<
  SearchExampleName,
  ReturnType<typeof loadSearchExample>
>;
type MockApiOptions = {
  host: string;
  port: number;
};

async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(
    await readFile(resolve(fixtureDirectory, filename), 'utf8'),
  ) as unknown;
}

function loadSearchExample(value: unknown) {
  return SearchResponseSchema.parse(value);
}

function createErrorResponse(
  code: ErrorCode,
  errors: Map<ErrorCode, ErrorObject>,
): Response {
  const error = errors.get(code);
  if (!error) throw new Error(`Missing ${code} mock API error fixture.`);
  return HttpResponse.json(error, { status: ERROR_HTTP_STATUS[code] });
}

function authorize(
  request: Request,
  scope: 'search' | 'read' | 'compare',
  errors: Map<ErrorCode, ErrorObject>,
): Response | undefined {
  const authorization = request.headers.get('authorization');
  const token = authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
  const scopes = token ? mockTokens.get(token) : undefined;
  if (!scopes) return createErrorResponse('unauthorized', errors);
  if (!scopes.includes(scope)) return createErrorResponse('forbidden', errors);
  return undefined;
}

function selectExample<T>(
  request: Request,
  defaultName: string,
  examples: Map<string, T>,
  errors: Map<ErrorCode, ErrorObject>,
): { value: T } | { response: Response } {
  const prefer = request.headers.get('prefer');
  const selectedName = prefer?.match(/\bexample="?([A-Za-z0-9_-]+)"?/i)?.[1];
  if (prefer && !selectedName) {
    return { response: createErrorResponse('invalid_request', errors) };
  }

  const name = selectedName ?? defaultName;
  const value = examples.get(name);
  if (value === undefined) {
    return { response: createErrorResponse('invalid_request', errors) };
  }
  return { value };
}

async function loadFixtures(): Promise<{
  compare: ReturnType<typeof CompareResponseSchema.parse>;
  datasetDetail: ReturnType<typeof DatasetDetailSchema.parse>;
  errors: Map<ErrorCode, ErrorObject>;
  searchExamples: SearchExamples;
}> {
  const searchExamples = new Map<
    SearchExampleName,
    ReturnType<typeof loadSearchExample>
  >();
  for (const name of searchExampleNames) {
    const response = await readJson(`${name}.json`);
    searchExamples.set(name, loadSearchExample(response));
  }

  const errors = new Map<ErrorCode, ErrorObject>();
  for (const code of ErrorCodeSchema.options) {
    const error = ErrorObjectSchema.parse(
      await readJson(`errors/error-${code}.json`),
    );
    errors.set(code, error);
  }

  return {
    compare: CompareResponseSchema.parse(
      await readJson('compare-synthetic.json'),
    ),
    datasetDetail: DatasetDetailSchema.parse(
      await readJson('dataset-detail.json'),
    ),
    errors,
    searchExamples,
  };
}

export async function createMockApiServer() {
  const fixtures = await loadFixtures();
  const handlers = [
    http.post('/search', async ({ request }) => {
      const authFailure = authorize(request, 'search', fixtures.errors);
      if (authFailure) return authFailure;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return createErrorResponse('invalid_request', fixtures.errors);
      }
      if (!SearchRequestSchema.safeParse(body).success) {
        return createErrorResponse('invalid_request', fixtures.errors);
      }

      const selection = selectExample(
        request,
        'search-results',
        fixtures.searchExamples,
        fixtures.errors,
      );
      if ('response' in selection) return selection.response;
      return HttpResponse.json(selection.value);
    }),
    http.get('/results/:request_id', ({ params, request }) => {
      const authFailure = authorize(request, 'read', fixtures.errors);
      if (authFailure) return authFailure;

      const selection = selectExample(
        request,
        'search-results',
        fixtures.searchExamples,
        fixtures.errors,
      );
      if ('response' in selection) return selection.response;
      if (selection.value.request_id !== params['request_id']) {
        return createErrorResponse('not_found', fixtures.errors);
      }
      return HttpResponse.json(selection.value);
    }),
    http.get('/dataset/:dataset_id', ({ params, request }) => {
      const authFailure = authorize(request, 'read', fixtures.errors);
      if (authFailure) return authFailure;

      const selection = selectExample(
        request,
        'dataset-detail',
        new Map([['dataset-detail', fixtures.datasetDetail]]),
        fixtures.errors,
      );
      if ('response' in selection) return selection.response;
      if (selection.value.dataset.dataset_id !== params['dataset_id']) {
        return createErrorResponse('not_found', fixtures.errors);
      }
      return HttpResponse.json(selection.value);
    }),
    http.post('/compare', async ({ request }) => {
      const authFailure = authorize(request, 'compare', fixtures.errors);
      if (authFailure) return authFailure;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return createErrorResponse('invalid_request', fixtures.errors);
      }
      const parsedRequest = CompareRequestSchema.safeParse(body);
      if (!parsedRequest.success) {
        return createErrorResponse('invalid_request', fixtures.errors);
      }

      const selection = selectExample(
        request,
        'compare-synthetic',
        new Map([['compare-synthetic', fixtures.compare]]),
        fixtures.errors,
      );
      if ('response' in selection) return selection.response;
      const fixtureIds = selection.value.datasets
        .map(({ dataset }) => dataset.dataset_id)
        .sort();
      if (
        JSON.stringify([...parsedRequest.data.dataset_ids].sort()) !==
        JSON.stringify(fixtureIds)
      ) {
        return createErrorResponse('not_found', fixtures.errors);
      }
      return HttpResponse.json(selection.value);
    }),
  ];

  return createServer(...handlers);
}

export async function startMockApiServer(
  { host, port }: MockApiOptions = { host: '127.0.0.1', port: 4010 },
): Promise<void> {
  const server = await createMockApiServer();
  server.listen(port, host, () => {
    console.log(`DataScout mock API listening at http://${host}:${port}`);
  });
}
