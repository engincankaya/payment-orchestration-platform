import type { Server as HttpServer } from 'node:http';

import type { Knex } from 'knex';

import type RabbitMqConnectionManager from '../messaging/rabbitmq-connection-manager';
import type ServerApplication from '../server/server';
import type { Logger } from '../utils/logger';
import type OutboxPublisherWorker from '../workers/outbox-publisher-worker';

const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

type BootstrapLifecycleState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped';

export default class PaymentServiceBootstrap {
  private readonly server: ServerApplication;
  private readonly outboxPublisherWorker: OutboxPublisherWorker;
  private readonly rabbitMqConnectionManager: RabbitMqConnectionManager;
  private readonly knex: Knex;
  private readonly logger: Logger;
  private readonly port: number;
  private readonly shutdownGraceMs: number;
  private httpServer: HttpServer | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private rabbitMqClosePromise: Promise<void> | null = null;
  private lifecycleState: BootstrapLifecycleState = 'idle';

  constructor(deps: {
    env: NodeJS.ProcessEnv;
    knex: Knex;
    logger: Logger;
    outboxPublisherWorker: OutboxPublisherWorker;
    rabbitMqConnectionManager: RabbitMqConnectionManager;
    server: ServerApplication;
  }) {
    this.server = deps.server;
    this.outboxPublisherWorker = deps.outboxPublisherWorker;
    this.rabbitMqConnectionManager = deps.rabbitMqConnectionManager;
    this.knex = deps.knex;
    this.logger = deps.logger;
    this.port = Number(deps.env.PORT ?? 8080);
    this.shutdownGraceMs = this.parsePositiveInteger(
      deps.env.OUTBOX_SHUTDOWN_GRACE_MS,
      'OUTBOX_SHUTDOWN_GRACE_MS',
      DEFAULT_SHUTDOWN_GRACE_MS,
    );
  }

  /** Starts HTTP before activating the outbox publisher worker. */
  public bootstrap = async (): Promise<void> => {
    if (
      this.lifecycleState === 'stopping'
      || this.lifecycleState === 'stopped'
    ) {
      throw new Error('Payment service cannot bootstrap after shutdown');
    }
    if (!this.bootstrapPromise) {
      this.lifecycleState = 'starting';
      this.bootstrapPromise = this.start().then(() => {
        if (this.lifecycleState === 'starting') {
          this.lifecycleState = 'running';
        }
      });
    }
    return this.bootstrapPromise;
  };

  /** Shuts down HTTP, worker, RabbitMQ, and Knex in ownership order. */
  public shutdown = async (): Promise<void> => {
    if (!this.shutdownPromise) {
      this.lifecycleState = 'stopping';
      this.shutdownPromise = this.stop().finally(() => {
        this.lifecycleState = 'stopped';
      });
    }
    return this.shutdownPromise;
  };

  /** Routes a process signal through the idempotent shutdown path. */
  public handleSignal = async (
    signal: 'SIGTERM' | 'SIGINT',
  ): Promise<void> => {
    this.logger.info(`Received ${signal}; shutting down payment-service`);
    await this.shutdown();
  };

  private start = async () => {
    await new Promise<void>((resolve, reject) => {
      const httpServer = this.server.app.listen(this.port, resolve);
      this.httpServer = httpServer;
      if (typeof httpServer.once === 'function') {
        httpServer.once('error', reject);
      }
    });
    if (this.lifecycleState !== 'starting') {
      throw new Error('Payment service shutdown interrupted bootstrap');
    }
    await this.outboxPublisherWorker.start();
  };

  private stop = async () => {
    let firstError: unknown;
    try {
      await this.closeHttpServer();
      const workerStop = this.outboxPublisherWorker.stop();
      const stoppedWithinGrace = await this.settlesWithinGrace(workerStop);
      if (!stoppedWithinGrace) {
        await this.closeRabbitMq();
        await workerStop;
      }
    } catch (error) {
      firstError = error;
    }

    try {
      await this.closeRabbitMq();
    } catch (error) {
      firstError ??= error;
    }
    try {
      await this.knex.destroy();
    } catch (error) {
      firstError ??= error;
    }

    if (firstError) {
      throw firstError;
    }
  };

  private closeHttpServer = async () => {
    if (!this.httpServer) {
      return;
    }
    const httpServer = this.httpServer;
    this.httpServer = null;
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  };

  private settlesWithinGrace = async (operation: Promise<void>) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.shutdownGraceMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  private closeRabbitMq = async () => {
    if (!this.rabbitMqClosePromise) {
      this.rabbitMqClosePromise = this.rabbitMqConnectionManager.close();
    }
    return this.rabbitMqClosePromise;
  };

  private parsePositiveInteger(
    value: string | undefined,
    name: string,
    defaultValue: number,
  ) {
    if (value === undefined) {
      return defaultValue;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive finite integer`);
    }
    return parsed;
  }
}
