import { asValue, NameAndRegistrationPair } from 'awilix';
import knexFactory, { Knex } from 'knex';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { buildContainer } from '../../src/bootstrap/container';
import * as createPaymentsMigration from '../../src/bootstrap/knex/migrations/001_create_payments';
import * as createIdempotencyKeysMigration from '../../src/bootstrap/knex/migrations/002_create_idempotency_keys';
import * as addIdempotencyLeaseMetadata from '../../src/bootstrap/knex/migrations/003_add_idempotency_lease_metadata';
import * as hardenPaymentIntegrity from '../../src/bootstrap/knex/migrations/004_harden_payment_integrity';
import * as addIdempotencyProcessingToken from '../../src/bootstrap/knex/migrations/005_add_idempotency_processing_token';
import * as createOutboxEventsMigration from '../../src/bootstrap/knex/migrations/006_create_outbox_events';
import type IdempotencyDataAccess from '../../src/data-access/idempotency/idempotency-data-access';
import PaymentsDataAccess from '../../src/data-access/payments/payments-data-access';
import TransactionManager from '../../src/data-access/transaction-manager';
import IdempotencyService from '../../src/services/idempotency/idempotency-service';
import OutboxService from '../../src/services/outbox/outbox-service';
import PaymentsService from '../../src/services/payments/payments-service';

const postgresUser = 'payment_atomicity_test';
const postgresPassword = 'payment_atomicity_test';
const postgresDatabase = 'payment_atomicity_test';
const merchantId = '11111111-1111-4111-8111-111111111111';
const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function createKnex(connection: string) {
  return knexFactory({
    client: 'pg',
    connection,
    pool: { min: 0, max: 8 },
  });
}

function buildPostgresConnectionUri(container: StartedTestContainer) {
  return `postgres://${postgresUser}:${postgresPassword}@${container.getHost()}:${container.getMappedPort(5432)}/${postgresDatabase}`;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('PaymentsService PostgreSQL transaction atomicity', () => {
  let postgres: StartedTestContainer;
  let knex: Knex;

  beforeAll(async () => {
    postgres = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: postgresUser,
        POSTGRES_PASSWORD: postgresPassword,
        POSTGRES_DB: postgresDatabase,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start();
    knex = createKnex(buildPostgresConnectionUri(postgres));
    await createPaymentsMigration.up(knex);
    await createIdempotencyKeysMigration.up(knex);
    await addIdempotencyLeaseMetadata.up(knex);
    await hardenPaymentIntegrity.up(knex);
    await addIdempotencyProcessingToken.up(knex);
    await createOutboxEventsMigration.up(knex);
  }, 120_000);

  afterAll(async () => {
    await knex?.destroy();
    await postgres?.stop();
  });

  it.each([
    {
      amountMinor: 1000,
      expectedEventType: 'payment.authorized.v1',
      expectedOperation: undefined,
      expectedStatus: 'AUTHORIZED',
    },
    {
      amountMinor: 9999,
      expectedEventType: 'payment.failed.v1',
      expectedOperation: 'AUTHORIZE',
      expectedStatus: 'FAILED',
    },
  ])(
    'commits create $expectedStatus, its outbox event, and idempotency completion once',
    async ({ amountMinor, expectedEventType, expectedOperation, expectedStatus }) => {
      await resetDatabase();
      const provider = createProvider();
      const service = resolvePaymentsService(provider.registry);
      const command = {
        correlationId: `trace-create-${expectedStatus.toLowerCase()}`,
        idempotencyKey: `idem-create-${expectedStatus.toLowerCase()}`,
        merchantId,
        amountMinor,
        currency: 'TRY',
      };

      const first = await service.create(command);
      const replay = await service.create(command);
      const payment = await knex('payments').where({ id: first.body.id }).first();
      const events = await knex('outbox_events')
        .where({ aggregate_id: first.body.id, event_type: expectedEventType });
      const idempotency = await knex('idempotency_keys')
        .where({ idempotency_key: command.idempotencyKey })
        .first();

      expect(first.body.status).toBe(expectedStatus);
      expect(replay).toEqual(first);
      expect(payment.status).toBe(expectedStatus);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        correlationId: command.correlationId,
        aggregateId: first.body.id,
        payload: {
          paymentId: first.body.id,
          merchantId,
          amountMinor,
          currency: 'TRY',
          provider: 'integration-provider',
          providerPaymentId: expectedStatus === 'AUTHORIZED'
            ? `provider_${first.body.id}`
            : null,
          ...(expectedOperation
            ? {
              operation: expectedOperation,
              status: expectedStatus,
              failureCode: 'MOCK_AUTHORIZATION_FAILED',
              failureMessage: 'Mock provider authorization failure',
              failedAt: expect.any(String),
            }
            : {
              authorizedAt: expect.any(String),
            }),
        },
      });
      expect(idempotency.status).toBe('COMPLETED');
      expect(provider.authorize).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      amountMinor: 1000,
      expectedEventType: 'payment.captured.v1',
      expectedOperation: undefined,
      expectedStatus: 'CAPTURED',
    },
    {
      amountMinor: 8888,
      expectedEventType: 'payment.failed.v1',
      expectedOperation: 'CAPTURE',
      expectedStatus: 'CAPTURE_FAILED',
    },
  ])(
    'commits capture $expectedStatus, its outbox event, and idempotency completion once',
    async ({ amountMinor, expectedEventType, expectedOperation, expectedStatus }) => {
      await resetDatabase();
      const paymentId = expectedStatus === 'CAPTURED'
        ? '22222222-2222-4222-8222-222222222222'
        : '33333333-3333-4333-8333-333333333333';
      await insertAuthorizedPayment(paymentId, amountMinor);
      const provider = createProvider();
      const service = resolvePaymentsService(provider.registry);
      const command = {
        correlationId: `trace-capture-${expectedStatus.toLowerCase()}`,
        idempotencyKey: `idem-capture-${expectedStatus.toLowerCase()}`,
        paymentId,
      };

      const first = await service.capture(command);
      const replay = await service.capture(command);
      const payment = await knex('payments').where({ id: paymentId }).first();
      const events = await knex('outbox_events')
        .where({ aggregate_id: paymentId, event_type: expectedEventType });
      const idempotency = await knex('idempotency_keys')
        .where({ idempotency_key: command.idempotencyKey })
        .first();

      expect(first.body.status).toBe(expectedStatus);
      expect(replay).toEqual(first);
      expect(payment.status).toBe(expectedStatus);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        correlationId: command.correlationId,
        aggregateId: paymentId,
        payload: {
          paymentId,
          merchantId,
          amountMinor,
          currency: 'TRY',
          provider: 'integration-provider',
          providerPaymentId: `provider_${paymentId}`,
          ...(expectedOperation
            ? {
              operation: expectedOperation,
              status: expectedStatus,
              failureCode: 'MOCK_CAPTURE_FAILED',
              failureMessage: 'Mock provider capture failure',
              failedAt: expect.any(String),
            }
            : {
              capturedAt: expect.any(String),
            }),
        },
      });
      expect(idempotency.status).toBe('COMPLETED');
      expect(provider.capture).toHaveBeenCalledTimes(1);
    },
  );

  it('marks a missing-payment capture idempotency record failed', async () => {
    await resetDatabase();
    const service = resolvePaymentsService(createProvider().registry);
    const command = {
      correlationId: 'trace-capture-missing',
      idempotencyKey: 'idem-capture-missing',
      paymentId: '44444444-4444-4444-8444-444444444444',
    };

    await expect(service.capture(command)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_FOUND',
      statusCode: 404,
    });

    await expect(knex('idempotency_keys')
      .where({ idempotency_key: command.idempotencyKey })
      .first()).resolves.toMatchObject({ status: 'FAILED' });
  });

  it.each(['FAILED', 'CAPTURED'])(
    're-evaluates a %s payment rejection without calling the provider',
    async (status) => {
      await resetDatabase();
      const paymentId = status === 'FAILED'
        ? '55555555-5555-4555-8555-555555555555'
        : '66666666-6666-4666-8666-666666666666';
      await insertPayment(paymentId, 1000, status);
      const provider = createProvider();
      const service = resolvePaymentsService(provider.registry);
      const command = {
        correlationId: `trace-${status.toLowerCase()}`,
        idempotencyKey: `idem-${status.toLowerCase()}`,
        paymentId,
      };

      await expect(service.capture(command)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_CAPTURABLE',
        statusCode: 409,
      });
      await expect(service.capture(command)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_CAPTURABLE',
        statusCode: 409,
      });
      const idempotency = await knex('idempotency_keys')
        .where({ idempotency_key: command.idempotencyKey })
        .first();

      expect(idempotency.status).toBe('FAILED');
      expect(provider.capture).not.toHaveBeenCalled();
    },
  );

  it('treats the same idempotency key on different payment scopes independently', async () => {
    await resetDatabase();
    const firstPaymentId = '77777777-7777-4777-8777-777777777777';
    const secondPaymentId = '88888888-8888-4888-8888-888888888888';
    await insertAuthorizedPayment(firstPaymentId, 1000);
    await insertAuthorizedPayment(secondPaymentId, 1000);
    const provider = createProvider();
    const service = resolvePaymentsService(provider.registry);

    const first = await service.capture({
      correlationId: 'trace-scope-1',
      idempotencyKey: 'shared-capture-key',
      paymentId: firstPaymentId,
    });
    const second = await service.capture({
      correlationId: 'trace-scope-2',
      idempotencyKey: 'shared-capture-key',
      paymentId: secondPaymentId,
    });

    expect(first.body.status).toBe('CAPTURED');
    expect(second.body.status).toBe('CAPTURED');
    expect(provider.capture).toHaveBeenCalledTimes(2);
  });

  it('serializes different idempotency keys on the payment row and performs one provider capture', async () => {
    await resetDatabase();
    const paymentId = '99999999-9999-4999-8999-999999999999';
    await insertAuthorizedPayment(paymentId, 1000);
    const providerEntered = deferred();
    const releaseProvider = deferred();
    const provider = createProvider({
      capture: jest.fn().mockImplementationOnce(async () => {
        providerEntered.resolve();
        await releaseProvider.promise;
        return { success: true, provider: 'integration-provider' };
      }),
    });
    const service = resolvePaymentsService(provider.registry);
    const secondLockQuery = deferred();
    const onQuery = (query: { sql?: string }) => {
      if (query.sql?.toLowerCase().includes('for update')) {
        secondLockQuery.resolve();
      }
    };
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    let results: PromiseSettledResult<unknown>[] = [];

    try {
      first = service.capture({
        correlationId: 'trace-row-lock-1',
        idempotencyKey: 'row-lock-key-1',
        paymentId,
      });
      await withTimeout(providerEntered.promise, 'first provider capture did not start');

      knex.on('query', onQuery);
      second = service.capture({
        correlationId: 'trace-row-lock-2',
        idempotencyKey: 'row-lock-key-2',
        paymentId,
      });
      await withTimeout(secondLockQuery.promise, 'second row-lock query did not start');
      releaseProvider.resolve();
      results = await withTimeout(
        Promise.allSettled([first, second]),
        'concurrent capture requests did not settle',
      );
    } finally {
      releaseProvider.resolve();
      knex.removeListener('query', onQuery);
      const pending = [first, second].filter(
        (promise): promise is Promise<unknown> => promise !== undefined,
      );
      await withTimeout(
        Promise.allSettled(pending),
        'concurrent capture cleanup timed out',
      ).catch(() => undefined);
    }

    const stored = await knex('payments').where({ id: paymentId }).first();
    const eventCount = await knex('outbox_events')
      .where({ aggregate_id: paymentId, event_type: 'payment.captured.v1' })
      .count<{ count: string }[]>('* as count');

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'PAYMENT_NOT_CAPTURABLE' }),
      }),
    ]);
    expect(provider.capture).toHaveBeenCalledTimes(1);
    expect(stored.status).toBe('CAPTURED');
    expect(Number(eventCount[0].count)).toBe(1);
  });

  it('rejects an active same-key capture while the owner continues once', async () => {
    await resetDatabase();
    const paymentId = '12121212-1212-4212-8212-121212121212';
    await insertAuthorizedPayment(paymentId, 1000);
    const providerEntered = deferred();
    const releaseProvider = deferred();
    const provider = createProvider({
      capture: jest.fn().mockImplementation(async () => {
        providerEntered.resolve();
        await releaseProvider.promise;
        return { success: true, provider: 'integration-provider' };
      }),
    });
    const service = resolvePaymentsService(provider.registry);
    const command = {
      correlationId: 'trace-same-key-concurrency',
      idempotencyKey: 'same-key-concurrency',
      paymentId,
    };
    let owner: Promise<unknown> | undefined;
    let competitor: Promise<unknown> | undefined;

    try {
      owner = service.capture(command);
      await withTimeout(providerEntered.promise, 'owner provider capture did not start');

      competitor = service.capture(command);
      await expect(withTimeout(
        competitor,
        'same-key competing capture did not reject',
      )).rejects.toMatchObject({
        code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        statusCode: 409,
      });
      releaseProvider.resolve();
      await expect(withTimeout(
        owner,
        'same-key owner capture did not complete',
      )).resolves.toMatchObject({
        statusCode: 200,
        body: { status: 'CAPTURED' },
      });
    } finally {
      releaseProvider.resolve();
      const pending = [owner, competitor].filter(
        (promise): promise is Promise<unknown> => promise !== undefined,
      );
      await withTimeout(
        Promise.allSettled(pending),
        'same-key capture cleanup timed out',
      ).catch(() => undefined);
    }

    expect(provider.capture).toHaveBeenCalledTimes(1);
    const eventCount = await knex('outbox_events')
      .where({ aggregate_id: paymentId, event_type: 'payment.captured.v1' })
      .count<{ count: string }[]>('* as count');
    expect(Number(eventCount[0].count)).toBe(1);
  });

  it.each(['CREATE', 'CAPTURE'] as const)(
    'rolls back payment state when %s outbox insertion fails',
    async (operation) => {
      await resetDatabase();
      const paymentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      if (operation === 'CAPTURE') {
        await insertAuthorizedPayment(paymentId, 1000);
      }
      const provider = createProvider();
      const outboxError = new Error('outbox insert failed');
      const service = resolvePaymentsService(provider.registry, {
        outboxEventsDataAccess: asValue({
          insertPending: jest.fn().mockRejectedValue(outboxError),
        }),
      });
      const idempotencyKey = `idem-${operation.toLowerCase()}-outbox-failure`;

      const action = operation === 'CREATE'
        ? service.create({
          correlationId: 'trace-create-outbox-failure',
          idempotencyKey,
          merchantId,
          amountMinor: 1000,
          currency: 'TRY',
        })
        : service.capture({
          correlationId: 'trace-capture-outbox-failure',
          idempotencyKey,
          paymentId,
        });

      await expect(action).rejects.toBe(outboxError);

      const payments = await knex('payments').select('id', 'status');
      const outboxCount = await knex('outbox_events').count<{ count: string }[]>('* as count');
      const idempotency = await knex('idempotency_keys')
        .where({ idempotency_key: idempotencyKey })
        .first();
      expect(operation === 'CREATE' ? payments : payments[0].status).toEqual(
        operation === 'CREATE' ? [] : 'AUTHORIZED',
      );
      expect(Number(outboxCount[0].count)).toBe(0);
      expect(idempotency.status).toBe('FAILED');
    },
  );

  it.each(['CREATE', 'CAPTURE'] as const)(
    'rolls back payment and outbox when %s idempotency completion fails',
    async (operation) => {
      await resetDatabase();
      const paymentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      if (operation === 'CAPTURE') {
        await insertAuthorizedPayment(paymentId, 1000);
      }
      const provider = createProvider();
      const idempotencyError = new Error('idempotency completion failed');
      const actualDataAccess = createTestContainer(provider.registry)
        .resolve<IdempotencyDataAccess>('idempotencyDataAccess');
      const failingDataAccess = Object.assign(Object.create(actualDataAccess), {
        markCompleted: jest.fn().mockRejectedValue(idempotencyError),
      });
      const service = resolvePaymentsService(provider.registry, {
        idempotencyDataAccess: asValue(failingDataAccess),
      });
      const idempotencyKey = `idem-${operation.toLowerCase()}-completion-failure`;

      const action = operation === 'CREATE'
        ? service.create({
          correlationId: 'trace-create-completion-failure',
          idempotencyKey,
          merchantId,
          amountMinor: 1000,
          currency: 'TRY',
        })
        : service.capture({
          correlationId: 'trace-capture-completion-failure',
          idempotencyKey,
          paymentId,
        });

      await expect(action).rejects.toBe(idempotencyError);

      const payments = await knex('payments').select('id', 'status');
      const outboxCount = await knex('outbox_events').count<{ count: string }[]>('* as count');
      const idempotency = await knex('idempotency_keys')
        .where({ idempotency_key: idempotencyKey })
        .first();
      expect(operation === 'CREATE' ? payments : payments[0].status).toEqual(
        operation === 'CREATE' ? [] : 'AUTHORIZED',
      );
      expect(Number(outboxCount[0].count)).toBe(0);
      expect(idempotency.status).toBe('FAILED');
    },
  );

  it('rolls back payment and outbox when a stale owner completes with an old token', async () => {
    await resetDatabase();
    const paymentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const idempotencyRecordId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const currentToken = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await knex('idempotency_keys').insert({
      id: idempotencyRecordId,
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-stale-owner-atomicity',
      request_hash: 'hash-stale-owner',
      status: 'PROCESSING',
      resource_type: 'payment',
      resource_id: paymentId,
      processing_token: currentToken,
    });
    const container = createTestContainer(createProvider().registry);
    const paymentsDataAccess = container.resolve<PaymentsDataAccess>('paymentsDataAccess');
    const outboxService = container.resolve<OutboxService>('outboxService');
    const idempotencyService = container.resolve<IdempotencyService>('idempotencyService');
    const transactionManager = container.resolve<TransactionManager>('transactionManager');

    await expect(transactionManager.run(async (trx) => {
      const payment = await paymentsDataAccess.insert({
        id: paymentId,
        merchant_id: merchantId,
        amount_minor: '1000',
        currency: 'TRY',
        status: 'AUTHORIZED',
        provider: 'integration-provider',
        provider_payment_id: `provider_${paymentId}`,
        failure_code: null,
        failure_message: null,
        authorized_at: new Date(),
        failed_at: null,
      }, trx);
      await outboxService.recordPaymentAuthorized({
        correlationId: 'trace-stale-owner',
        payment,
      }, trx);
      await idempotencyService.markCompleted({
        idempotencyRecordId,
        processingToken: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        responseStatusCode: 201,
        responseBody: { id: paymentId },
        resourceType: 'payment',
        resourceId: paymentId,
        trx,
      });
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_OWNERSHIP_LOST' });

    await expect(knex('payments').where({ id: paymentId }).first()).resolves.toBeUndefined();
    await expect(knex('outbox_events').where({ aggregate_id: paymentId }).first())
      .resolves.toBeUndefined();
    await expect(knex('idempotency_keys').where({ id: idempotencyRecordId }).first())
      .resolves.toMatchObject({
        status: 'PROCESSING',
        processing_token: currentToken,
      });
  });

  async function resetDatabase() {
    await knex.raw(
      'TRUNCATE TABLE outbox_events, idempotency_keys, payments RESTART IDENTITY CASCADE',
    );
  }

  function createTestContainer(
    providerRegistryService: ReturnType<typeof createProvider>['registry'],
    overrides: NameAndRegistrationPair<unknown> = {},
  ) {
    return buildContainer({
      env: asValue({
        INTERNAL_SERVICE_TOKEN: 'atomicity-test-token',
        SERVICE_NAME: 'payment-service-test',
      }),
      knex: asValue(knex),
      logger: asValue(silentLogger),
      providerRegistryService: asValue(providerRegistryService),
      ...overrides,
    });
  }

  function resolvePaymentsService(
    providerRegistryService: ReturnType<typeof createProvider>['registry'],
    overrides: NameAndRegistrationPair<unknown> = {},
  ) {
    return createTestContainer(providerRegistryService, overrides)
      .resolve<PaymentsService>('paymentsService');
  }

  function insertAuthorizedPayment(id: string, amountMinor: number) {
    return insertPayment(id, amountMinor, 'AUTHORIZED');
  }

  function insertPayment(id: string, amountMinor: number, status: string) {
    return knex('payments').insert({
      id,
      merchant_id: merchantId,
      amount_minor: amountMinor,
      currency: 'TRY',
      status,
      provider: 'integration-provider',
      provider_payment_id: `provider_${id}`,
      failure_code: status === 'FAILED' ? 'PREVIOUS_FAILURE' : null,
      failure_message: status === 'FAILED' ? 'Previous failure' : null,
      authorized_at: status === 'AUTHORIZED' ? new Date() : null,
      captured_at: status === 'CAPTURED' ? new Date() : null,
      failed_at: status === 'FAILED' ? new Date() : null,
    });
  }
});

function createProvider(overrides: { capture?: jest.Mock } = {}) {
  const authorize = jest.fn().mockImplementation(async (input) => {
    if (input.amountMinor === 9999) {
      return {
        success: false,
        provider: 'integration-provider',
        failureCode: 'MOCK_AUTHORIZATION_FAILED',
        failureMessage: 'Mock provider authorization failure',
      };
    }
    return {
      success: true,
      provider: 'integration-provider',
      providerPaymentId: `provider_${input.paymentId}`,
    };
  });
  const capture = overrides.capture ?? jest.fn().mockImplementation(async (input) => {
    if (input.amountMinor === 8888) {
      return {
        success: false,
        provider: 'integration-provider',
        failureCode: 'MOCK_CAPTURE_FAILED',
        failureMessage: 'Mock provider capture failure',
      };
    }
    return { success: true, provider: 'integration-provider' };
  });
  const provider = { authorize, capture };
  return {
    authorize,
    capture,
    registry: {
      getDefaultProvider: jest.fn().mockReturnValue(provider),
      getProvider: jest.fn().mockReturnValue(provider),
    },
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
