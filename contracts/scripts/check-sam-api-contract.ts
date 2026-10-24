import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, parseDocument } from 'yaml';

type RouteMap = Map<string, string[]>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const httpMethods = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizedScopes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((scope) => typeof scope === 'string')
  ) {
    return [];
  }
  return [...value].sort();
}

function addRoute(
  routes: RouteMap,
  method: string,
  path: string,
  scopes: string[],
  source: string,
): void {
  const normalizedMethod = method.toUpperCase();
  if (!httpMethods.has(normalizedMethod) || !path.startsWith('/')) {
    throw new Error(`${source} has an invalid API route: ${method} ${path}`);
  }

  const key = `${normalizedMethod} ${path}`;
  if (routes.has(key)) {
    throw new Error(`${source} defines duplicate API route ${key}.`);
  }
  routes.set(key, scopes);
}

export function collectOpenApiRoutes(document: unknown): RouteMap {
  const paths = asRecord(asRecord(document)?.paths);
  if (!paths) throw new Error('OpenAPI document has no paths object.');

  const routes: RouteMap = new Map();
  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = asRecord(pathItemValue);
    if (!pathItem) throw new Error(`OpenAPI path ${path} is not an object.`);

    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!httpMethods.has(method.toUpperCase())) continue;
      const operation = asRecord(operationValue);
      if (!operation) {
        throw new Error(
          `OpenAPI operation ${method.toUpperCase()} ${path} is invalid.`,
        );
      }

      const security = Array.isArray(operation.security)
        ? operation.security
        : [];
      const scopes = security.flatMap((requirement) => {
        const cognitoScopes = asRecord(requirement)?.cognito;
        return normalizedScopes(cognitoScopes);
      });
      addRoute(routes, method, path, scopes.sort(), 'OpenAPI');
    }
  }

  return routes;
}

export function collectSamRoutes(template: unknown): RouteMap {
  const resources = asRecord(asRecord(template)?.Resources);
  if (!resources) throw new Error('SAM template has no Resources object.');

  const routes: RouteMap = new Map();
  for (const [resourceName, resourceValue] of Object.entries(resources)) {
    const resource = asRecord(resourceValue);
    if (resource?.Type !== 'AWS::Serverless::Function') continue;

    const functionProperties = asRecord(resource.Properties);
    const events = asRecord(functionProperties?.Events);
    if (!events) continue;

    for (const [eventName, eventValue] of Object.entries(events)) {
      const event = asRecord(eventValue);
      if (event?.Type !== 'Api') continue;

      const properties = asRecord(event.Properties);
      const path = properties?.Path;
      const method = properties?.Method;
      if (typeof path !== 'string' || typeof method !== 'string') {
        throw new Error(
          `SAM API event ${resourceName}.${eventName} must define string Path and Method.`,
        );
      }

      const auth = asRecord(properties?.Auth);
      addRoute(
        routes,
        method,
        path,
        normalizedScopes(auth?.AuthorizationScopes),
        `SAM event ${resourceName}.${eventName}`,
      );
    }
  }

  return routes;
}

export function findRouteDifferences(
  openApiRoutes: RouteMap,
  samRoutes: RouteMap,
): string[] {
  const differences: string[] = [];
  const allRoutes = [
    ...new Set([...openApiRoutes.keys(), ...samRoutes.keys()]),
  ].sort();

  for (const route of allRoutes) {
    const openApiScopes = openApiRoutes.get(route);
    const samScopes = samRoutes.get(route);

    if (!openApiScopes) {
      differences.push(`${route}: present in SAM only`);
    } else if (!samScopes) {
      differences.push(`${route}: present in OpenAPI only`);
    } else if (
      openApiScopes.length !== samScopes.length ||
      openApiScopes.some((scope, index) => scope !== samScopes[index])
    ) {
      differences.push(
        `${route}: scope mismatch (OpenAPI: [${openApiScopes.join(', ')}]; SAM: [${samScopes.join(', ')}])`,
      );
    }
  }

  return differences;
}

export function parseSamTemplate(source: string): unknown {
  const document = parseDocument(source, { logLevel: 'silent' });
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid SAM YAML: ${document.errors.map((error) => error.message).join('; ')}`,
    );
  }
  return document.toJS();
}

async function main(): Promise<void> {
  const samTemplatePath =
    process.argv[2] ?? resolve(scriptDirectory, '../../backend/template.yaml');
  if (!existsSync(samTemplatePath)) {
    console.warn(
      `SKIP: SAM route parity is pending; template not found at ${samTemplatePath}. CI will enforce parity when B1 adds the template.`,
    );
    return;
  }

  const openApiDocument = parse(
    await readFile(resolve(scriptDirectory, '../openapi.yaml'), 'utf8'),
  );
  const samTemplate = parseSamTemplate(await readFile(samTemplatePath, 'utf8'));
  const differences = findRouteDifferences(
    collectOpenApiRoutes(openApiDocument),
    collectSamRoutes(samTemplate),
  );

  if (differences.length > 0) {
    console.error('SAM routes, methods, and scopes differ from openapi.yaml:');
    for (const difference of differences) console.error(`- ${difference}`);
    process.exitCode = 1;
    return;
  }

  console.log('PASS: SAM routes, methods, and scopes match openapi.yaml.');
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
