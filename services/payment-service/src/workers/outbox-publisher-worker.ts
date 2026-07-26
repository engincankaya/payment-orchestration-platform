import type OutboxEventsDataAccess from '../data-access/outbox/outbox-events-data-access';
import type {
  OutboxEventRecord,
} from '../data-access/outbox/outbox-events-data-access';
import type { TransactionManagerPort } from '../data-access/transaction-manager';
import type RabbitMqConnectionManager from '../messaging/rabbitmq-connection-manager';
import RabbitMqPublisher, {
  RabbitMqPublishNotAttemptedError,
} from '../messaging/rabbitmq-publisher';
import type { Logger } from '../utils/logger';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

export interface ClockPort {
  now(): Date;
}

interface WorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

type WorkerLifecycleState = 'idle' | 'running' | 'stopping' | 'stopped';

export default class OutboxPublisherWorker {
  private readonly outboxEventsDataAccess: OutboxEventsDataAccess;
  private readonly transactionManager: TransactionManagerPort;
  private readonly rabbitMqPublisher: RabbitMqPublisher;
  private readonly rabbitMqConnectionManager: RabbitMqConnectionManager;
  private readonly logger: Logger;
  private readonly clock: ClockPort;
  private readonly config: WorkerConfig;
  private lifecycleState: WorkerLifecycleState = 'idle';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(deps: {
    clock: ClockPort;
    env: NodeJS.ProcessEnv;
    logger: Logger;
    outboxEventsDataAccess: OutboxEventsDataAccess;
    rabbitMqConnectionManager: RabbitMqConnectionManager;
    rabbitMqPublisher: RabbitMqPublisher;
    transactionManager: TransactionManagerPort;
  }) {
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.outboxEventsDataAccess = deps.outboxEventsDataAccess;
    this.rabbitMqConnectionManager = deps.rabbitMqConnectionManager;
    this.rabbitMqPublisher = deps.rabbitMqPublisher;
    this.transactionManager = deps.transactionManager;
    this.config = {
      pollIntervalMs: this.parsePositiveInteger(
        deps.env.OUTBOX_POLL_INTERVAL_MS,
        'OUTBOX_POLL_INTERVAL_MS',
        DEFAULT_POLL_INTERVAL_MS,
      ),
      batchSize: this.parsePositiveInteger(
        deps.env.OUTBOX_BATCH_SIZE,
        'OUTBOX_BATCH_SIZE',
        DEFAULT_BATCH_SIZE,
      ),
      maxAttempts: this.parsePositiveInteger(
        deps.env.OUTBOX_MAX_ATTEMPTS,
        'OUTBOX_MAX_ATTEMPTS',
        DEFAULT_MAX_ATTEMPTS,
      ),
      retryBaseDelayMs: this.parsePositiveInteger(
        deps.env.OUTBOX_RETRY_BASE_DELAY_MS,
        'OUTBOX_RETRY_BASE_DELAY_MS',
        DEFAULT_RETRY_BASE_DELAY_MS,
      ),
      retryMaxDelayMs: this.parsePositiveInteger(
        deps.env.OUTBOX_RETRY_MAX_DELAY_MS,
        'OUTBOX_RETRY_MAX_DELAY_MS',
        DEFAULT_RETRY_MAX_DELAY_MS,
      ),
    };
    this.parsePositiveInteger(
      deps.env.OUTBOX_SHUTDOWN_GRACE_MS,
      'OUTBOX_SHUTDOWN_GRACE_MS',
      DEFAULT_SHUTDOWN_GRACE_MS,
    );
  }

  /** Starts a non-overlapping polling loop without waiting for RabbitMQ. */
  public start = async (): Promise<void> => {
    if (this.lifecycleState === 'running') {
      return;
    }
    if (this.lifecycleState !== 'idle') {
      throw new Error('Outbox publisher worker cannot restart after stop');
    }
    this.lifecycleState = 'running';
    this.stopPromise = null;
    this.scheduleNext();
  };

  /** Stops scheduling and waits for the current polling iteration. */
  public stop = async (): Promise<void> => {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.lifecycleState = 'stopping';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopPromise = (this.inFlight ?? Promise.resolve()).finally(() => {
      this.lifecycleState = 'stopped';
    });
    return this.stopPromise;
  };

  /** Publishes one locked batch and records outcomes in its transaction. */
  public pollOnce = async (): Promise<void> => {
    await this.rabbitMqConnectionManager.getConfirmChannel();
    await this.transactionManager.run(async (trx) => {
      const events = await this.outboxEventsDataAccess.fetchPendingBatch(
        this.config.batchSize,
        trx,
      );
      for (const event of events) {
        await this.publishEvent(event, trx);
      }
    });
  };

  private publishEvent = async (
    event: OutboxEventRecord,
    trx: Parameters<OutboxEventsDataAccess['markPublished']>[1],
  ) => {
    try {
      await this.rabbitMqPublisher.publish(event);
    } catch (error) {
      if (error instanceof RabbitMqPublishNotAttemptedError) {
        throw error;
      }
      const delayMs = this.retryDelayFor(event.attempts);
      await this.outboxEventsDataAccess.markPublishFailed({
        id: event.id,
        lastError: this.errorMessage(error),
        maxAttempts: this.config.maxAttempts,
        nextRetryAt: new Date(this.clock.now().getTime() + delayMs),
      }, trx);
      return;
    }
    await this.outboxEventsDataAccess.markPublished(event.id, trx);
  };

  private scheduleNext() {
    if (this.lifecycleState !== 'running') {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const iteration = this.pollOnce()
        .catch((error) => {
          this.logger.error('Outbox polling iteration failed', { error });
        })
        .finally(() => {
          if (this.inFlight === iteration) {
            this.inFlight = null;
          }
          this.scheduleNext();
        });
      this.inFlight = iteration;
    }, this.config.pollIntervalMs);
  }

  private retryDelayFor(attempts: number) {
    const exponent = Math.min(attempts, 52);
    return Math.min(
      this.config.retryMaxDelayMs,
      this.config.retryBaseDelayMs * (2 ** exponent),
    );
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

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
