import { AwilixContainer } from 'awilix';
import { Application, RequestHandler } from 'express';

import { Routes } from './routes';
import { createValidationHandler } from './validations/common-validations';

type ExpressMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

function resolveMiddleware(container: AwilixContainer, middlewareName: string): RequestHandler {
  if (!container.hasRegistration(middlewareName)) {
    throw new Error(`Middleware not found: ${middlewareName}`);
  }

  const middleware = container.resolve<RequestHandler>(middlewareName);

  if (typeof middleware !== 'function') {
    throw new Error(`Middleware not found: ${middlewareName}`);
  }

  return middleware;
}

function resolveController(container: AwilixContainer, controllerPath: string): RequestHandler {
  const [controllerName, methodName, ...extraParts] = controllerPath.split('.');

  if (!controllerName || !methodName || extraParts.length > 0) {
    throw new Error(`Invalid route controller: ${controllerPath}`);
  }

  if (!container.hasRegistration(controllerName)) {
    throw new Error(`Controller not found: ${controllerName}`);
  }

  const controller = container.resolve<Record<string, unknown>>(controllerName);
  const controllerMethod = controller[methodName];

  if (typeof controllerMethod !== 'function') {
    throw new Error(`Controller method not found: ${controllerPath}`);
  }

  return controllerMethod as RequestHandler;
}

export default function initCustomRoutes(app: Application, container: AwilixContainer) {
  for (const route of Routes) {
    const { method, path, controller, config } = route;

    if (typeof app[method as ExpressMethod] !== 'function') {
      throw new Error(`Unsupported HTTP method: ${method}`);
    }

    const validationHandler = createValidationHandler(config.validation);
    const middlewares = config.middlewares.map((middlewareName) =>
      resolveMiddleware(container, middlewareName),
    );
    const controllerFunction = resolveController(container, controller);

    // Gateway auth must run before validation so unauthenticated clients cannot probe request schemas.
    app[method as ExpressMethod](path, ...middlewares, validationHandler, controllerFunction);
  }
}
