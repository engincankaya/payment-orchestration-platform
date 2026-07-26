import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

import { asValue } from 'awilix';
import * as amqpClient from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import knexFactory, { Knex } from 'knex';
import request from 'supertest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { buildContainer } from '../../src/bootstrap/container';
import * as createPaymentsMigration from '../../src/bootstrap/knex/migrations/001_create_payments';
import * as createIdempotencyKeysMigration from '../../src/bootstrap/knex/migrations/002_create_idempotency_keys';
import * as addIdempotencyLeaseMetadata from '../../src/bootstrap/knex/migrations/003_add_idempotency_lease_metadata';
import * as hardenPaymentIntegrity from '../../src/bootstrap/knex/migrations/004_harden_payment_integrity';
import * as addIdempotencyProcessingToken from '../../src/bootstrap/knex/migrations/005_add_idempotency_processing_token';
import * as createOutboxEventsMigration from '../../src/bootstrap/knex/migrations/006_create_outbox_events';
import type OutboxEventsDataAccess from '../../src/data-access/outbox/outbox-events-data-access';
import type RabbitMqConnectionManager from '../../src/messaging/rabbitmq-connection-manager';
import type ServerApplication from '../../src/server/server';
import type OutboxPublisherWorker from '../../src/workers/outbox-publisher-worker';

const postgresUser = 'outbox_publish_test';
const postgresPassword = 'outbox_publish_test';
const postgresDatabase = 'outbox_publish_test';
const capturedSchemaPath = path.resolve(
  __dirname,
  '../../../../docs/contracts/events/payment-captured.v1.schema.json',
);
const capturedSchema = JSON.parse(readFileSync(capturedSchemaPath, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateCapturedEvent = ajv.compile(capturedSchema);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function buildPostgresConnectionUri(container: StartedTestContainer) {
  return `postgres://${postgresUser}:${postgresPassword}@${container.getHost()}:${container.getMappedPort(5432)}/${postgresDatabase}`;
}

function buildRabbitMqUri(container: StartedTestContainer) {
  return `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
}

function eventEnvelope(eventId: string) {
  return {
    eventId,
    eventType: 'payment.captured.v1',
    eventVersion: 1,
    occurredAt: '2026-07-26T10:00:00.000Z',
    correlationId: 'stage-7-integration',
    source: 'payment-service',
    aggregateType: 'payment',
    aggregateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    payload: {
      paymentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      merchantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      amountMinor: 1000,
      currency: 'TRY',
      provider: 'mock-provider',
      providerPaymentId: 'mock-payment-stage-7',
      capturedAt: '2026-07-26T10:00:00.000Z',
    },
  };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function findAvailablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function waitForChildExit(child: ChildProcess, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }

  return withTimeout(new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }), timeoutMs, 'Payment Service process did not exit in time');
}

async function waitForHealth(port: number, child: ChildProcess) {
  return withTimeout((async () => {
    while (child.exitCode === null && child.signalCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) {
          return response;
        }
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Payment Service exited before health became available');
  })(), 10_000, 'Payment Service health did not become available');
}

async function waitForMessage(
  channel: Channel,
  queue: string,
  timeoutMs = 5_000,
): Promise<ConsumeMessage> {
  return new Promise<ConsumeMessage>((resolve, reject) => {
    let consumerTag: string | undefined;
    const timeout = setTimeout(() => {
      if (consumerTag) {
        void channel.cancel(consumerTag).catch(() => undefined);
      }
      reject(new Error(`Timed out waiting for a message from ${queue}`));
    }, timeoutMs);

    void channel.consume(queue, (message) => {
      clearTimeout(timeout);
      if (!message) {
        reject(new Error(`Queue ${queue} was cancelled before a message arrived`));
        return;
      }
      channel.ack(message);
      if (consumerTag) {
        void channel.cancel(consumerTag)
          .catch(() => undefined)
          .finally(() => resolve(message));
        return;
      }
      resolve(message);
    }, { noAck: false }).then(({ consumerTag: tag }) => {
      consumerTag = tag;
    }).catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe('Outbox publisher with PostgreSQL and RabbitMQ', () => {
  let postgres: StartedTestContainer;
  let rabbitMq: StartedTestContainer;
  let knex: Knex;
  let rabbitConnection: ChannelModel;
  let rabbitChannel: Channel;
  const resourcesToClose: Array<{ close(): Promise<unknown> }> = [];
  const queuesToDelete: string[] = [];

  beforeAll(async () => {
    [postgres, rabbitMq] = await Promise.all([
      new GenericContainer('postgres:16-alpine')
        .withEnvironment({
          POSTGRES_USER: postgresUser,
          POSTGRES_PASSWORD: postgresPassword,
          POSTGRES_DB: postgresDatabase,
        })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage(
          'database system is ready to accept connections',
          2,
        ))
        .start(),
      new GenericContainer('rabbitmq:3-management-alpine')
        .withExposedPorts(5672)
        .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
        .start(),
    ]);
    knex = knexFactory({
      client: 'pg',
      connection: buildPostgresConnectionUri(postgres),
      pool: { min: 0, max: 5 },
    });
    await createPaymentsMigration.up(knex);
    await createIdempotencyKeysMigration.up(knex);
    await addIdempotencyLeaseMetadata.up(knex);
    await hardenPaymentIntegrity.up(knex);
    await addIdempotencyProcessingToken.up(knex);
    await createOutboxEventsMigration.up(knex);
    await openObserverConnection();
  }, 180_000);

  beforeEach(async () => {
    await knex('outbox_events').delete();
  });

  afterEach(async () => {
    while (queuesToDelete.length > 0) {
      const queue = queuesToDelete.pop();
      if (queue) {
        await rabbitChannel.deleteQueue(queue).catch(() => undefined);
      }
    }
    while (resourcesToClose.length > 0) {
      await resourcesToClose.pop()?.close().catch(() => undefined);
    }
  });

  afterAll(async () => {
    await rabbitChannel?.close().catch(() => undefined);
    await rabbitConnection?.close().catch(() => undefined);
    await knex?.destroy();
    await Promise.all([
      postgres?.stop(),
      rabbitMq?.stop(),
    ]);
  });

  async function openObserverConnection() {
    rabbitConnection = await amqpClient.connect(buildRabbitMqUri(rabbitMq));
    rabbitChannel = await rabbitConnection.createChannel();
  }

  function createContainer(
    overrides: Record<string, unknown> = {},
    rabbitMqUrl = buildRabbitMqUri(rabbitMq),
    envOverrides: NodeJS.ProcessEnv = {},
  ) {
    return buildContainer({
      env: asValue({
        INTERNAL_SERVICE_TOKEN: 'stage-7-token',
        SERVICE_NAME: 'payment-service-test',
        RABBITMQ_URL: rabbitMqUrl,
        OUTBOX_POLL_INTERVAL_MS: '25',
        OUTBOX_BATCH_SIZE: '10',
        OUTBOX_MAX_ATTEMPTS: '3',
        OUTBOX_RETRY_BASE_DELAY_MS: '1',
        OUTBOX_RETRY_MAX_DELAY_MS: '10',
        RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS: '1000',
        OUTBOX_SHUTDOWN_GRACE_MS: '1000',
        ...envOverrides,
      }),
      knex: asValue(knex),
      amqpClient: asValue(amqpClient),
      logger: asValue({
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
      }),
      ...overrides,
    });
  }

  async function insertPending(eventId: string) {
    const envelope = eventEnvelope(eventId);
    await knex('outbox_events').insert({
      id: eventId,
      aggregate_type: 'payment',
      aggregate_id: envelope.payload.paymentId,
      event_type: envelope.eventType,
      event_version: envelope.eventVersion,
      routing_key: envelope.eventType,
      payload: envelope,
    });
    return envelope;
  }

  async function declareObserverQueue(binding = true) {
    const queue = `stage7.${randomUUID()}`;
    await rabbitChannel.assertExchange('payments.events', 'topic', { durable: true });
    await rabbitChannel.assertQueue(queue, {
      durable: false,
      autoDelete: false,
      exclusive: false,
    });
    if (binding) {
      await rabbitChannel.bindQueue(queue, 'payments.events', 'payment.captured.v1');
    }
    queuesToDelete.push(queue);
    return queue;
  }

  it('publishes a valid captured event and marks its database row PUBLISHED', async () => {
    const queue = await declareObserverQueue();
    const eventId = '11111111-1111-4111-8111-111111111111';
    const expectedEnvelope = await insertPending(eventId);
    const container = createContainer();
    const manager = container.resolve<RabbitMqConnectionManager>(
      'rabbitMqConnectionManager',
    );
    resourcesToClose.push(manager);
    const worker = container.resolve<OutboxPublisherWorker>('outboxPublisherWorker');
    const received = waitForMessage(rabbitChannel, queue);

    await worker.pollOnce();

    const message = await received;
    const body = JSON.parse(message.content.toString('utf8'));
    expect(body).toEqual(expectedEnvelope);
    expect(validateCapturedEvent(body)).toBe(true);
    expect(message.fields.routingKey).toBe(expectedEnvelope.eventType);
    expect(message.properties).toMatchObject({
      deliveryMode: 2,
      contentType: 'application/json',
      messageId: eventId,
      correlationId: expectedEnvelope.correlationId,
      type: expectedEnvelope.eventType,
    });
    await expect(knex('outbox_events').where({ id: eventId }).first()).resolves
      .toMatchObject({
        status: 'PUBLISHED',
        attempts: 0,
        published_at: expect.anything(),
      });
  });

  it('keeps a persistent message in a bound queue until a consumer reads it', async () => {
    const queue = await declareObserverQueue();
    const eventId = '77777777-7777-4777-8777-777777777777';
    const expectedEnvelope = await insertPending(eventId);
    const container = createContainer();
    const manager = container.resolve<RabbitMqConnectionManager>(
      'rabbitMqConnectionManager',
    );
    resourcesToClose.push(manager);
    const worker = container.resolve<OutboxPublisherWorker>('outboxPublisherWorker');

    await worker.pollOnce();

    const message = await rabbitChannel.get(queue, { noAck: true });
    if (message === false) {
      throw new Error('Expected RabbitMQ to retain the persistent message');
    }
    expect(message.properties.deliveryMode).toBe(2);
    expect(message.properties.messageId).toBe(eventId);
    expect(JSON.parse(message.content.toString('utf8'))).toEqual(expectedEnvelope);
  });

  it('leaves an event untouched when no broker connection can be established and HTTP stays healthy', async () => {
    const eventId = '22222222-2222-4222-8222-222222222222';
    await insertPending(eventId);
    const secondConnectionAttempt = deferred();
    let connectionAttempts = 0;
    const unavailableAmqpClient = {
      connect: jest.fn(async (url: string) => {
        connectionAttempts += 1;
        if (connectionAttempts === 2) {
          secondConnectionAttempt.resolve();
        }
        return amqpClient.connect(url);
      }),
    };
    const container = createContainer({
      amqpClient: asValue(unavailableAmqpClient),
    }, 'amqp://127.0.0.1:1');
    const manager = container.resolve<RabbitMqConnectionManager>(
      'rabbitMqConnectionManager',
    );
    resourcesToClose.push(manager);
    const worker = container.resolve<OutboxPublisherWorker>('outboxPublisherWorker');
    const server = container.resolve<ServerApplication>('server');

    await expect(worker.start()).resolves.toBeUndefined();
    await withTimeout(
      secondConnectionAttempt.promise,
      5_000,
      'Worker did not retry the unavailable broker connection',
    );
    await worker.stop();

    await expect(request(server.app).get('/health')).resolves.toMatchObject({
      status: 200,
      body: { status: 'ok', service: 'payment-service-test' },
    });
    await expect(knex('outbox_events').where({ id: eventId }).first()).resolves
      .toMatchObject({
        status: 'PENDING',
        attempts: 0,
        next_retry_at: null,
      });
  });

  it('retries an unroutable mandatory message with the same identity after a binding appears', async () => {
    const queue = await declareObserverQueue(false);
    const eventId = '33333333-3333-4333-8333-333333333333';
    const expectedEnvelope = await insertPending(eventId);
    const retryDelayMs = 2_000;
    const databaseNowResult = await knex.raw(
      'SELECT clock_timestamp() AS database_now',
    );
    const databaseNow = new Date(databaseNowResult.rows[0].database_now);
    const container = createContainer(
      {
        clock: asValue({
          now: () => databaseNow,
        }),
      },
      buildRabbitMqUri(rabbitMq),
      {
        OUTBOX_RETRY_BASE_DELAY_MS: String(retryDelayMs),
        OUTBOX_RETRY_MAX_DELAY_MS: String(retryDelayMs),
      },
    );
    const manager = container.resolve<RabbitMqConnectionManager>(
      'rabbitMqConnectionManager',
    );
    resourcesToClose.push(manager);
    const worker = container.resolve<OutboxPublisherWorker>('outboxPublisherWorker');

    await worker.pollOnce();

    const failedAttempt = await knex('outbox_events').where({ id: eventId }).first();
    expect(failedAttempt).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      last_error: expect.stringMatching(/NO_ROUTE/),
      next_retry_at: expect.anything(),
    });
    const retryAt = new Date(failedAttempt.next_retry_at).getTime();
    expect(retryAt).toBe(databaseNow.getTime() + retryDelayMs);

    await rabbitChannel.bindQueue(queue, 'payments.events', expectedEnvelope.eventType);
    await knex('outbox_events').where({ id: eventId }).update({
      next_retry_at: knex.fn.now(),
    });
    const received = waitForMessage(rabbitChannel, queue);
    await worker.pollOnce();

    const message = await received;
    expect(JSON.parse(message.content.toString('utf8'))).toEqual(expectedEnvelope);
    expect(message.properties.messageId).toBe(eventId);
    await expect(knex('outbox_events').where({ id: eventId }).first()).resolves
      .toMatchObject({ status: 'PUBLISHED', attempts: 1 });
  });

  it('reconnects with mandatory-return protection and keeps HTTP healthy', async () => {
    const queue = await declareObserverQueue();
    const container = createContainer();
    const manager = container.resolve<RabbitMqConnectionManager>(
      'rabbitMqConnectionManager',
    );
    resourcesToClose.push(manager);
    const worker = container.resolve<OutboxPublisherWorker>('outboxPublisherWorker');
    const server = container.resolve<ServerApplication>('server');
    await manager.getConfirmChannel();

    const observerClosed = once(rabbitConnection, 'close');
    await rabbitMq.exec([
      'rabbitmqctl',
      'close_all_connections',
      'stage-7 reconnect integration test',
    ]);
    await withTimeout(
      observerClosed,
      5_000,
      'RabbitMQ did not close the established observer connection',
    );
    await openObserverConnection();
    await rabbitChannel.unbindQueue(
      queue,
      'payments.events',
      'payment.captured.v1',
    );
    const eventId = '44444444-4444-4444-8444-444444444444';
    await insertPending(eventId);

    await worker.pollOnce();

    await expect(knex('outbox_events').where({ id: eventId }).first()).resolves
      .toMatchObject({
        status: 'PENDING',
        attempts: 1,
        last_error: expect.stringMatching(/NO_ROUTE/),
      });
    await expect(rabbitChannel.get(queue, { noAck: true })).resolves.toBe(false);

    await rabbitChannel.bindQueue(
      queue,
      'payments.events',
      'payment.captured.v1',
    );
    await knex('outbox_events').where({ id: eventId }).update({
      next_retry_at: knex.fn.now(),
    });
    const received = waitForMessage(rabbitChannel, queue);
    await worker.pollOnce();

    const message = await received;
    expect(message.properties.messageId).toBe(eventId);
    await expect(knex('outbox_events').where({ id: eventId }).first()).resolves
      .toMatchObject({ status: 'PUBLISHED' });
    await expect(request(server.app).get('/health')).resolves.toMatchObject({
      status: 200,
      body: { status: 'ok' },
    });
  });

  it('retries with the identical eventId, AMQP identity, routing key, and body after a post-confirm DB failure', async () => {
    const queue = await declareObserverQueue();
    const eventId = '55555555-5555-4555-8555-555555555555';
    const expectedEnvelope = await insertPending(eventId);
    const baseContainer = createContainer();
    const realDataAccess = baseContainer.resolve<OutboxEventsDataAccess>(
      'outboxEventsDataAccess',
    );
    let failMarkPublished = true;
    const dataAccessOverride = {
      insertPending: realDataAccess.insertPending,
      fetchPendingBatch: realDataAccess.fetchPendingBatch,
      markPublishFailed: realDataAccess.markPublishFailed,
      markPublished: jest.fn(async (...args: Parameters<
        OutboxEventsDataAccess['markPublished']
      >) => {
        if (failMarkPublished) {
          failMarkPublished = false;
          throw new Error('post-confirm database failure');
        }
        return realDataAccess.markPublished(...args);
      }),
    };
    const container = createContainer({
      outboxEventsDataAccess: asValue(dataAccessOverride),
    });
    const manager = container.resolve<RabbitMqConnectionManager>(
      'rabbitMqConnectionManager',
    );
    resourcesToClose.push(manager);
    const worker = container.resolve<OutboxPublisherWorker>('outboxPublisherWorker');
    const firstReceived = waitForMessage(rabbitChannel, queue);

    await expect(worker.pollOnce()).rejects.toThrow('post-confirm database failure');
    const first = await firstReceived;
    const secondReceived = waitForMessage(rabbitChannel, queue);
    await worker.pollOnce();
    const second = await secondReceived;

    expect(first.properties.messageId).toBe(eventId);
    expect(second.properties.messageId).toBe(eventId);
    expect(first.fields.routingKey).toBe(expectedEnvelope.eventType);
    expect(second.fields.routingKey).toBe(expectedEnvelope.eventType);
    expect(first.content.equals(second.content)).toBe(true);
    expect(JSON.parse(second.content.toString('utf8'))).toEqual(expectedEnvelope);
    await expect(knex('outbox_events').where({ id: eventId }).first()).resolves
      .toMatchObject({ status: 'PUBLISHED', attempts: 0 });
  });

  it('boots the production entrypoint, starts the worker, and shuts down cleanly on SIGTERM', async () => {
    const queue = await declareObserverQueue();
    const eventId = '66666666-6666-4666-8666-666666666666';
    await insertPending(eventId);
    const port = await findAvailablePort();
    const child = spawn(process.execPath, [
      '-r',
      'ts-node/register/transpile-only',
      'services/payment-service/src/index.ts',
    ], {
      cwd: path.resolve(__dirname, '../../../..'),
      env: {
        ...process.env,
        SERVICE_NAME: 'payment-service-entrypoint-test',
        PORT: String(port),
        DATABASE_URL: buildPostgresConnectionUri(postgres),
        RABBITMQ_URL: buildRabbitMqUri(rabbitMq),
        INTERNAL_SERVICE_TOKEN: 'stage-7-token',
        OUTBOX_POLL_INTERVAL_MS: '25',
        OUTBOX_BATCH_SIZE: '10',
        OUTBOX_MAX_ATTEMPTS: '3',
        OUTBOX_RETRY_BASE_DELAY_MS: '1',
        OUTBOX_RETRY_MAX_DELAY_MS: '10',
        RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS: '1000',
        OUTBOX_SHUTDOWN_GRACE_MS: '1000',
        TS_NODE_PROJECT: path.resolve(
          __dirname,
          '../../tsconfig.json',
        ),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    child.stdout?.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr?.on('data', (chunk) => output.push(chunk.toString()));

    try {
      const health = await waitForHealth(port, child);
      await expect(health.json()).resolves.toMatchObject({
        status: 'ok',
        service: 'payment-service-entrypoint-test',
      });
      const received = waitForMessage(rabbitChannel, queue, 10_000);
      const message = await received;
      expect(message.properties.messageId).toBe(eventId);

      child.kill('SIGTERM');
      const exit = await waitForChildExit(child);
      expect(exit).toEqual({ code: 0, signal: null });
      await expect(knex('outbox_events').where({ id: eventId }).first()).resolves
        .toMatchObject({ status: 'PUBLISHED' });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${output.join('')}`,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child).catch(() => undefined);
      }
    }
  }, 20_000);

  it('fails the production entrypoint before HTTP listen when RabbitMQ config is missing', async () => {
    const port = await findAvailablePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SERVICE_NAME: 'payment-service-invalid-config-test',
      PORT: String(port),
      DATABASE_URL: buildPostgresConnectionUri(postgres),
      INTERNAL_SERVICE_TOKEN: 'stage-7-token',
      TS_NODE_PROJECT: path.resolve(
        __dirname,
        '../../tsconfig.json',
      ),
    };
    delete env.RABBITMQ_URL;
    const observerPath = path.resolve(
      __dirname,
      '../support/observe-http-listen.js',
    );
    const child = spawn(process.execPath, [observerPath], {
      cwd: path.resolve(__dirname, '../../../..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let observedHttpListen = false;
    child.on('message', (message) => {
      if (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'http-listen'
      ) {
        observedHttpListen = true;
      }
    });

    try {
      const exit = await waitForChildExit(child, 5_000);
      expect(exit.code).not.toBe(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observedHttpListen).toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child).catch(() => undefined);
      }
    }
  }, 20_000);
});
