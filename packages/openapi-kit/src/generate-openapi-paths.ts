import Joi from 'joi';

import { IRouteSettings } from './types';
import { convertJoiDescription, joiToOpenApiSchema } from './joi-to-openapi';

type ParameterLocation = 'path' | 'query' | 'header';

function toOpenApiPath(expressPath: string) {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function createParameters(schema: Joi.Schema | undefined, location: ParameterLocation) {
  if (!schema) {
    return [];
  }

  const description = schema.describe();
  const keys = description.keys ?? {};

  return Object.entries(keys).map(([name, childDescription]) => {
    const child = childDescription as ReturnType<Joi.Schema['describe']>;
    const flags = child.flags as { presence?: string } | undefined;

    return {
      name,
      in: location,
      required: location === 'path' || flags?.presence === 'required',
      schema: convertJoiDescription(child),
    };
  });
}

function createRequestBody(schema: Joi.Schema | undefined) {
  if (!schema) {
    return undefined;
  }

  return {
    required: true,
    content: {
      'application/json': {
        schema: joiToOpenApiSchema(schema),
      },
    },
  };
}

function createResponses(route: IRouteSettings) {
  return Object.fromEntries(
    Object.entries(route.config.responses).map(([statusCode, response]) => [
      statusCode,
      {
        description: response.description,
        ...(response.schema
          ? {
              content: {
                'application/json': {
                  schema: response.schema,
                },
              },
            }
          : {}),
      },
    ]),
  );
}

export function generateOpenApiPaths(routes: IRouteSettings[]) {
  return routes.reduce<Record<string, Record<string, unknown>>>((paths, route) => {
    const openApiPath = toOpenApiPath(route.path);
    const parameters = [
      ...createParameters(route.config.validation.params, 'path'),
      ...createParameters(route.config.validation.query, 'query'),
      ...createParameters(route.config.validation.headers, 'header'),
    ];

    paths[openApiPath] = {
      ...(paths[openApiPath] ?? {}),
      [route.method]: {
        tags: route.config.tags,
        description: route.config.description,
        parameters,
        requestBody: createRequestBody(route.config.validation.body),
        responses: createResponses(route),
      },
    };

    return paths;
  }, {});
}
