import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { SEARCH_QUERY_MAX_LENGTH } from '../src/schemas.js';

type OpenApiResponse = {
  $ref?: string;
  content?: Record<string, { schema: { $ref: string } }>;
};

type OpenApiOperation = {
  security?: Array<Record<string, string[]>>;
  requestBody?: { content: Record<string, { schema: { $ref: string } }> };
  responses: Record<string, OpenApiResponse>;
  description?: string;
  parameters?: Array<{ schema: { pattern: string } }>;
};

type OpenApiDocument = {
  openapi: string;
  info: { description: string };
  paths: Record<string, Partial<Record<'get' | 'post', OpenApiOperation>>>;
  components: {
    securitySchemes: {
      cognito: {
        type: string;
        flows: {
          authorizationCode: {
            authorizationUrl: string;
            tokenUrl: string;
            scopes: Record<string, string>;
          };
        };
        'x-amazon-apigateway-authorizer'?: unknown;
      };
    };
    schemas: Record<string, { $ref?: string }>;
    responses: { NotFound: { description: string } };
  };
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const contractsDirectory = resolve(testDirectory, '..');
const openApiPath = resolve(contractsDirectory, 'openapi.yaml');
const schemaDirectory = resolve(contractsDirectory, 'json-schema');
const bundledOpenApiPath = resolve(contractsDirectory, 'dist/openapi.yaml');
const document = parse(await readFile(openApiPath, 'utf8')) as OpenApiDocument;

const routeScopes = {
  'POST /search': 'datascout-api/search',
  'GET /results/{request_id}': 'datascout-api/read',
  'GET /dataset/{dataset_id}': 'datascout-api/read',
  'POST /compare': 'datascout-api/compare',
} as const;

function getOperation(route: string): OpenApiOperation {
  const [method, path] = route.split(' ');
  if (!method || !path) throw new Error(`Invalid test route: ${route}`);
  const operation =
    method === 'POST' ? document.paths[path]?.post : document.paths[path]?.get;
  if (!operation) throw new Error(`Missing OpenAPI operation ${route}.`);
  return operation;
}

describe('OpenAPI contract', () => {
  it('declares only the four planned routes and methods', () => {
    const actualRoutes = Object.entries(document.paths).flatMap(
      ([path, pathItem]) =>
        (['get', 'post'] as const).flatMap((method) =>
          pathItem[method] ? [`${method.toUpperCase()} ${path}`] : [],
        ),
    );

    expect(actualRoutes.sort()).toEqual(Object.keys(routeScopes).sort());
    expect(document.openapi).toBe('3.1.0');
  });

  it.each(Object.entries(routeScopes))(
    '%s requires only its assigned Cognito scope',
    (route, scope) => {
      expect(getOperation(route).security).toEqual([{ cognito: [scope] }]);
    },
  );

  it('defines Cognito Authorization Code with PKCE scopes', () => {
    const cognito = document.components.securitySchemes.cognito;

    expect(cognito.type).toBe('oauth2');
    expect(cognito.flows.authorizationCode.authorizationUrl).toContain(
      '{cognitoDomain}',
    );
    expect(cognito.flows.authorizationCode.tokenUrl).toContain(
      '{cognitoDomain}',
    );
    expect(Object.keys(cognito.flows.authorizationCode.scopes).sort()).toEqual([
      'datascout-api/compare',
      'datascout-api/read',
      'datascout-api/search',
    ]);
    expect(cognito['x-amazon-apigateway-authorizer']).toBeUndefined();
    expect(document.info.description).toMatch(
      /not imported into API\s+Gateway/,
    );
  });

  it('uses the shared request/response schemas and the 1,000-character search cap', () => {
    const search = getOperation('POST /search');
    const compare = getOperation('POST /compare');
    const searchRequestSchema =
      search.requestBody?.content['application/json']?.schema.$ref;
    const searchResponseSchema =
      search.responses['200']?.content?.['application/json']?.schema.$ref;
    const searchSchemaFile = resolve(
      schemaDirectory,
      'SearchRequest.schema.json',
    );

    expect(searchRequestSchema).toBe('#/components/schemas/SearchRequest');
    expect(searchResponseSchema).toBe('#/components/schemas/SearchResponse');
    expect(compare.requestBody?.content['application/json']?.schema.$ref).toBe(
      '#/components/schemas/CompareRequest',
    );
    expect(
      compare.responses['200']?.content?.['application/json']?.schema.$ref,
    ).toBe('#/components/schemas/CompareResponse');
    expect(SEARCH_QUERY_MAX_LENGTH).toBe(1_000);

    return readFile(searchSchemaFile, 'utf8').then((contents) => {
      const searchRequest = JSON.parse(contents);
      expect(searchRequest.properties.query).toMatchObject({
        type: 'string',
        maxLength: SEARCH_QUERY_MAX_LENGTH,
      });
    });
  });

  it('documents owner-only result reads and encoded dataset IDs', () => {
    const results = getOperation('GET /results/{request_id}');
    const dataset = getOperation('GET /dataset/{dataset_id}');

    expect(results.description).toContain('owner');
    expect(document.components.responses.NotFound.description).toContain(
      'not owned',
    );
    expect(dataset.parameters?.[0]?.schema.pattern).toBe(
      '^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$',
    );
    expect(dataset.description).toContain('percent-encoded');
  });

  it('uses the stable error schema for every documented error response', () => {
    for (const pathItem of Object.values(document.paths)) {
      for (const operation of Object.values(pathItem)) {
        if (!operation) continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (status === '200') continue;
          if (response.$ref) {
            expect(response.$ref).toMatch('#/components/responses/');
            continue;
          }
          expect(response.content?.['application/json']?.schema.$ref).toBe(
            '#/components/schemas/ErrorObject',
          );
        }
      }
    }
  });

  it('resolves every contract schema component to a generated file', async () => {
    for (const schema of Object.values(document.components.schemas)) {
      const reference = schema.$ref;
      expect(reference).toMatch(/^\.\/json-schema\/[A-Za-z]+\.schema\.json$/);
      if (!reference) throw new Error('Missing external schema reference.');
      await expect(
        readFile(resolve(contractsDirectory, reference), 'utf8'),
      ).resolves.toBeTruthy();
    }
  });

  it('bundles external schemas so downstream tools only need one document', async () => {
    const bundledDocument = parse(
      await readFile(bundledOpenApiPath, 'utf8'),
    ) as OpenApiDocument;
    const refs: string[] = [];
    const resolvePointer = (pointer: string): unknown =>
      pointer
        .slice(2)
        .split('/')
        .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce<unknown>((value, token) => {
          if (typeof value !== 'object' || value === null) return undefined;
          return (value as Record<string, unknown>)[token];
        }, bundledDocument);

    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== 'object' || value === null) return;

      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' && typeof child === 'string') refs.push(child);
        else visit(child);
      }
    };
    visit(bundledDocument);

    expect(refs.every((ref) => ref.startsWith('#/'))).toBe(true);
    expect(refs.every((ref) => resolvePointer(ref) !== undefined)).toBe(true);
    expect(bundledDocument.components.schemas.SearchRequest).toBeDefined();
  });
});
