import { AwilixContainer } from 'awilix';
import cors from 'cors';
import express, { Application, ErrorRequestHandler, RequestHandler } from 'express';
import { setupOpenApi } from '@payment-orchestration-platform/openapi-kit';

import initCustomRoutes from './init-custom-routes';
import { Routes } from './routes';

export default class ServerApplication {
  public app: Application;
  private container: AwilixContainer;
  private errorMiddleware: ErrorRequestHandler;
  private correlationIdMiddleware: RequestHandler;
  private env: NodeJS.ProcessEnv;

  constructor(deps: {
    container: AwilixContainer;
    errorMiddleware: ErrorRequestHandler;
    correlationIdMiddleware: RequestHandler;
    env: NodeJS.ProcessEnv;
  }) {
    this.app = express();
    this.container = deps.container;
    this.errorMiddleware = deps.errorMiddleware;
    this.correlationIdMiddleware = deps.correlationIdMiddleware;
    this.env = deps.env;

    this.configure();
  }

  private configure() {
    this.registerMiddlewares();
    this.registerRoutes();
    this.registerAfterMiddlewares();
    this.setupSwagger();
  }

  private registerMiddlewares() {
    this.app.use(express.json());
    this.registerCors();
    this.app.use(this.correlationIdMiddleware);
  }

  private registerRoutes() {
    initCustomRoutes(this.app, this.container);

    this.app.get('/health', (_req, res) => {
      return res.status(200).json({ status: 'ok', service: this.env.SERVICE_NAME });
    });
  }

  private registerAfterMiddlewares() {
    this.app.use(this.errorMiddleware);
  }

  private setupSwagger() {
    if (this.env.OPENAPI_DOCS_ENABLED !== 'true') {
      return;
    }

    setupOpenApi(this.app, {
      docsPath: '/internal-docs',
      title: `${this.env.SERVICE_NAME ?? 'ledger-service'} Internal API`,
      routes: Routes,
    });
  }

  private registerCors() {
    const allowedOrigins = this.parseAllowedOrigins();

    if (allowedOrigins.length === 0) {
      return;
    }

    this.app.use(cors({
      origin: (origin, callback) => {
        return callback(null, Boolean(origin && allowedOrigins.includes(origin)));
      },
    }));
  }

  private parseAllowedOrigins() {
    return (this.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
}
