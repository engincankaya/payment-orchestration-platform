import { AwilixContainer } from 'awilix';
import cors from 'cors';
import express, { Application, ErrorRequestHandler, RequestHandler } from 'express';

import initCustomRoutes from './init-custom-routes';

export default class ServerApplication {
  public app: Application;
  private container: AwilixContainer;
  private errorMiddleware: ErrorRequestHandler;
  private correlationIdMiddleware: RequestHandler;

  constructor(deps: {
    container: AwilixContainer;
    errorMiddleware: ErrorRequestHandler;
    correlationIdMiddleware: RequestHandler;
  }) {
    this.app = express();
    this.container = deps.container;
    this.errorMiddleware = deps.errorMiddleware;
    this.correlationIdMiddleware = deps.correlationIdMiddleware;

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
    this.app.use(cors({ origin: '*' }));
    this.app.use(this.correlationIdMiddleware);
  }

  private registerRoutes() {
    initCustomRoutes(this.app, this.container);

    this.app.get('/health', (_req, res) => {
      return res.status(200).json({ status: 'ok', service: process.env.SERVICE_NAME });
    });
  }

  private registerAfterMiddlewares() {
    this.app.use(this.errorMiddleware);
  }

  private setupSwagger() {
    // Route metadata stays compatible with future OpenAPI generation.
  }
}
