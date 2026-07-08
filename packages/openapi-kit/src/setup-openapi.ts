import { Application } from 'express';
import swaggerUi from 'swagger-ui-express';

import { generateOpenApiDocument } from './generate-openapi-document';
import { IRouteSettings } from './types';

export interface SetupOpenApiOptions {
  docsPath: string;
  title: string;
  version?: string;
  routes: IRouteSettings[];
}

export function setupOpenApi(app: Application, options: SetupOpenApiOptions) {
  // Routes are passed in by each service so this package stays infrastructure-only.
  const document = generateOpenApiDocument({
    title: options.title,
    version: options.version ?? '1.0.0',
    routes: options.routes,
  });

  app.get(`${options.docsPath}.json`, (_req, res) => {
    return res.status(200).json(document);
  });

  app.use(options.docsPath, swaggerUi.serve, swaggerUi.setup(document));
}
