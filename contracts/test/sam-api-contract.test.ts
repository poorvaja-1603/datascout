import { describe, expect, it } from 'vitest';
import {
  collectOpenApiRoutes,
  collectSamRoutes,
  findRouteDifferences,
  parseSamTemplate,
} from '../scripts/check-sam-api-contract.js';

const openApiDocument = {
  paths: {
    '/search': {
      post: { security: [{ cognito: ['datascout-api/search'] }] },
    },
    '/dataset/{dataset_id}': {
      get: { security: [{ cognito: ['datascout-api/read'] }] },
    },
  },
};

const samTemplate = {
  Resources: {
    SearchFunction: {
      Type: 'AWS::Serverless::Function',
      Properties: {
        Events: {
          Search: {
            Type: 'Api',
            Properties: {
              Path: '/search',
              Method: 'post',
              Auth: {
                Authorizer: 'CognitoAuthorizer',
                AuthorizationScopes: ['datascout-api/search'],
              },
            },
          },
        },
      },
    },
    DatasetFunction: {
      Type: 'AWS::Serverless::Function',
      Properties: {
        Events: {
          Dataset: {
            Type: 'Api',
            Properties: {
              Path: '/dataset/{dataset_id}',
              Method: 'get',
              Auth: {
                Authorizer: 'CognitoAuthorizer',
                AuthorizationScopes: ['datascout-api/read'],
              },
            },
          },
        },
      },
    },
  },
};

describe('SAM API contract parity', () => {
  it('parses CloudFormation intrinsic tags without hiding malformed YAML', () => {
    const template = parseSamTemplate(`
Resources:
  SearchFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: !Sub \${ProjectBucket}/search
      Events:
        Search:
          Type: Api
          Properties:
            Path: /search
            Method: post
            Auth:
              Authorizer: CognitoAuthorizer
              AuthorizationScopes:
                - datascout-api/search
`);

    expect(collectSamRoutes(template).get('POST /search')).toEqual([
      'datascout-api/search',
    ]);
    expect(() => parseSamTemplate('Resources: [')).toThrow('Invalid SAM YAML:');
  });

  it('matches SAM API event paths, methods, and scopes with OpenAPI', () => {
    expect(
      findRouteDifferences(
        collectOpenApiRoutes(openApiDocument),
        collectSamRoutes(samTemplate),
      ),
    ).toEqual([]);
  });

  it('reports routes and scope differences', () => {
    const mismatchedTemplate = structuredClone(samTemplate);
    mismatchedTemplate.Resources.SearchFunction.Properties.Events.Search.Properties.Auth.AuthorizationScopes =
      ['datascout-api/read'];
    mismatchedTemplate.Resources.DatasetFunction.Properties.Events.Dataset.Properties.Path =
      '/dataset/{id}';

    expect(
      findRouteDifferences(
        collectOpenApiRoutes(openApiDocument),
        collectSamRoutes(mismatchedTemplate),
      ),
    ).toEqual([
      'GET /dataset/{dataset_id}: present in OpenAPI only',
      'GET /dataset/{id}: present in SAM only',
      'POST /search: scope mismatch (OpenAPI: [datascout-api/search]; SAM: [datascout-api/read])',
    ]);
  });
});
