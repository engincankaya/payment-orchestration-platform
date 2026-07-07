import { generateOpenApiPaths } from './generate-openapi-paths';
import { IRouteSettings } from './types';

export interface GenerateOpenApiDocumentOptions {
  title: string;
  version: string;
  routes: IRouteSettings[];
}

export function generateOpenApiDocument(options: GenerateOpenApiDocumentOptions) {
  return {
    openapi: '3.0.3',
    info: {
      title: options.title,
      version: options.version,
    },
    paths: generateOpenApiPaths(options.routes),
  };
}
