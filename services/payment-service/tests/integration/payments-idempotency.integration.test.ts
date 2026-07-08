import { createHash } from 'crypto';

import { asValue } from 'awilix';
import knexFactory, { Knex } from 'knex';
import request from 'supertest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { buildContainer } from '../../src/bootstrap/container';
import * as createPaymentsMigration from '../../src/bootstrap/knex/migrations/001_create_payments';
import * as createIdempotencyKeysMigration from '../../src/bootstrap/knex/migrations/002_create_idempotency_keys';
import IdempotencyDataAccess from '../../src/data-access/idempotency/idempotency-data-access';
import ServerApplication from '../../src/server/server';

const internalToken = 'test-internal-token';
const merchantId = '11111111-1111-4111-8111-111111111111';
const postgresUser = 'payment_test';
const postgresPassword = 'payment_test';
const postgresDatabase = 'payment_test';
const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function createKnex(connection: string) {
  return knexFactory({
    client: 'pg',
    connection,
    pool: {
      min: 0,
      max: 2,
    },
  });
}

function buildPostgresConnectionUri(container: StartedTestContainer) {
  return `postgres://${postgresUser}:${postgresPassword}@${container.getHost()}:${container.getMappedPort(5432)}/${postgresDatabase}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }

  return value;
}

function buildRequestHash(body: unknown) {
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

function createProviderRegistryMock() {
  const authorize = jest.fn().mockImplementation(async (input) => ({
    success: input.amountMinor !== 9999,
    provider: 'integration-provider',
    providerPaymentId: input.amountMinor === 9999 ? undefined : `provider_${input.paymentId}`,
    failureCode: input.amountMinor === 9999 ? 'MOCK_AUTHORIZATION_FAILED' : undefined,
    failureMessage: input.amountMinor === 9999 ? 'Mock provider authorization failure' : undefined,
  }));

  return {
    authorize,
    registry: {
      getDefaultProvider: jest.fn().mockReturnValue({
        authorize,
        capture: jest.fn(),
      }),
    },
  };
}

async function truncateTables(knex: Knex) {
  await knex.raw('TRUNCATE TABLE idempotency_keys, payments RESTART IDENTITY CASCADE');
}

describe('Payment Service idempotency integration', () => {
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
  }, 120_000);

  afterAll(async () => {
    await knex?.destroy();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await truncateTables(knex);
  });

  function createTestContainer(providerRegistryService = createProviderRegistryMock().registry) {
    return buildContainer({
      env: asValue({
        INTERNAL_SERVICE_TOKEN: internalToken,
        SERVICE_NAME: 'payment-service-test',
      }),
      knex: asValue(knex),
      logger: asValue(silentLogger),
      providerRegistryService: asValue(providerRegistryService),
    });
  }

  function createApp(providerRegistryService = createProviderRegistryMock().registry) {
    const container = createTestContainer(providerRegistryService);

    return container.resolve<ServerApplication>('server').app;
  }

  it('does not insert a second processing record for the same scope and idempotency key', async () => {
    const dataAccess = createTestContainer().resolve<IdempotencyDataAccess>(
      'idempotencyDataAccess',
    );

    const first = await dataAccess.tryInsertProcessing({
      scope: `payments:create:${merchantId}`,
      idempotencyKey: 'idem-data-access-conflict',
      requestHash: 'hash-1',
    });
    const second = await dataAccess.tryInsertProcessing({
      scope: `payments:create:${merchantId}`,
      idempotencyKey: 'idem-data-access-conflict',
      requestHash: 'hash-1',
    });

    expect(first).toMatchObject({
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-data-access-conflict',
      status: 'PROCESSING',
    });
    expect(second).toBeNull();
  });

  it('allows the same idempotency key in a different scope at the database boundary', async () => {
    const dataAccess = createTestContainer().resolve<IdempotencyDataAccess>(
      'idempotencyDataAccess',
    );

    const first = await dataAccess.tryInsertProcessing({
      scope: `payments:create:${merchantId}`,
      idempotencyKey: 'idem-data-access-scope',
      requestHash: 'hash-1',
    });
    const second = await dataAccess.tryInsertProcessing({
      scope: 'payments:create:22222222-2222-4222-8222-222222222222',
      idempotencyKey: 'idem-data-access-scope',
      requestHash: 'hash-1',
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.scope).not.toBe(first?.scope);
  });

  it('does not create an idempotency record when idempotency-key is missing', async () => {
    const response = await request(createApp())
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .send({
        merchantId,
        amountMinor: 1000,
        currency: 'TRY',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');

    const count = await knex('idempotency_keys').count<{ count: string }[]>('* as count');
    expect(Number(count[0].count)).toBe(0);
  });

  it('does not create an idempotency record when body validation fails', async () => {
    const response = await request(createApp())
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-validation-error')
      .send({
        merchantId,
        amountMinor: 10.5,
        currency: 'TRY',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');

    const count = await knex('idempotency_keys').count<{ count: string }[]>('* as count');
    expect(Number(count[0].count)).toBe(0);
  });

  it('returns the same response for the same idempotency key and body without calling provider twice', async () => {
    const provider = createProviderRegistryMock();
    const app = createApp(provider.registry);
    const body = {
      merchantId,
      amountMinor: 1000,
      currency: 'TRY',
    };

    const first = await request(app)
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-replay-success')
      .send(body);
    const second = await request(app)
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-replay-success')
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(provider.authorize).toHaveBeenCalledTimes(1);
  });

  it('rejects the same idempotency key with a different request body', async () => {
    const app = createApp();

    const first = await request(app)
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-different-body')
      .send({
        merchantId,
        amountMinor: 1000,
        currency: 'TRY',
      });
    const second = await request(app)
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-different-body')
      .send({
        merchantId,
        amountMinor: 1001,
        currency: 'TRY',
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
  });

  it('rejects a request when the idempotency record is still processing', async () => {
    const body = {
      merchantId,
      amountMinor: 1000,
      currency: 'TRY',
    };

    await knex('idempotency_keys').insert({
      id: '22222222-2222-4222-8222-222222222222',
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-processing',
      request_hash: buildRequestHash(body),
      status: 'PROCESSING',
    });

    const response = await request(createApp())
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-processing')
      .send(body);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
  });

  it('allows the same idempotency key for a different merchant scope', async () => {
    const otherMerchantId = '22222222-2222-4222-8222-222222222222';
    const app = createApp();

    const first = await request(app)
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-same-key-different-merchant')
      .send({
        merchantId,
        amountMinor: 1000,
        currency: 'TRY',
      });
    const second = await request(app)
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-same-key-different-merchant')
      .send({
        merchantId: otherMerchantId,
        amountMinor: 1000,
        currency: 'TRY',
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });
});
