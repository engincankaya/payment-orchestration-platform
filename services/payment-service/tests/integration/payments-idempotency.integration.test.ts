import { createHash } from 'crypto';

import { asValue } from 'awilix';
import knexFactory, { Knex } from 'knex';
import request from 'supertest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { buildContainer } from '../../src/bootstrap/container';
import * as createPaymentsMigration from '../../src/bootstrap/knex/migrations/001_create_payments';
import * as createIdempotencyKeysMigration from '../../src/bootstrap/knex/migrations/002_create_idempotency_keys';
import * as addIdempotencyLeaseMetadata from '../../src/bootstrap/knex/migrations/003_add_idempotency_lease_metadata';
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
    await addIdempotencyLeaseMetadata.up(knex);
  }, 120_000);

  afterAll(async () => {
    await knex?.destroy();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await truncateTables(knex);
  });

  function createTestContainer(
    providerRegistryService = createProviderRegistryMock().registry,
    env: NodeJS.ProcessEnv = {},
  ) {
    return buildContainer({
      env: asValue({
        INTERNAL_SERVICE_TOKEN: internalToken,
        SERVICE_NAME: 'payment-service-test',
        ...env,
      }),
      knex: asValue(knex),
      logger: asValue(silentLogger),
      providerRegistryService: asValue(providerRegistryService),
    });
  }

  function createApp(
    providerRegistryService = createProviderRegistryMock().registry,
    env: NodeJS.ProcessEnv = {},
  ) {
    const container = createTestContainer(providerRegistryService, env);

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
      resource: { type: 'payment', id: '55555555-5555-4555-8555-555555555555' },
      processingExpiresAt: new Date(Date.now() + 60_000),
    });
    const second = await dataAccess.tryInsertProcessing({
      scope: `payments:create:${merchantId}`,
      idempotencyKey: 'idem-data-access-conflict',
      requestHash: 'hash-1',
      resource: { type: 'payment', id: '66666666-6666-4666-8666-666666666666' },
      processingExpiresAt: new Date(Date.now() + 60_000),
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
      resource: { type: 'payment', id: '77777777-7777-4777-8777-777777777777' },
      processingExpiresAt: new Date(Date.now() + 60_000),
    });
    const second = await dataAccess.tryInsertProcessing({
      scope: 'payments:create:22222222-2222-4222-8222-222222222222',
      idempotencyKey: 'idem-data-access-scope',
      requestHash: 'hash-1',
      resource: { type: 'payment', id: '88888888-8888-4888-8888-888888888888' },
      processingExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.scope).not.toBe(first?.scope);
  });

  it('reactivates a failed idempotency record with a fresh processing lease', async () => {
    const dataAccess = createTestContainer().resolve<IdempotencyDataAccess>(
      'idempotencyDataAccess',
    );
    const newLease = new Date(Date.now() + 60_000);

    await knex('idempotency_keys').insert({
      id: '99999999-9999-4999-8999-999999999999',
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-reactivate-failed',
      request_hash: 'hash-1',
      status: 'FAILED',
      resource_type: 'payment',
      resource_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    const record = await dataAccess.reactivateFailed(
      '99999999-9999-4999-8999-999999999999',
      'hash-1',
      newLease,
    );

    expect(record).toMatchObject({
      status: 'PROCESSING',
      resource_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(record?.processing_expires_at).not.toBeNull();
  });

  it('takes over an expired processing record only once and renews the lease', async () => {
    const dataAccess = createTestContainer().resolve<IdempotencyDataAccess>(
      'idempotencyDataAccess',
    );
    const idempotencyRecordId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    await knex('idempotency_keys').insert({
      id: idempotencyRecordId,
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-data-access-expired-processing',
      request_hash: 'hash-1',
      status: 'PROCESSING',
      resource_type: 'payment',
      resource_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      processing_expires_at: new Date(Date.now() - 1000),
    });

    const first = await dataAccess.takeoverExpiredProcessing(
      idempotencyRecordId,
      'hash-1',
      new Date(Date.now() + 60_000),
    );
    const second = await dataAccess.takeoverExpiredProcessing(
      idempotencyRecordId,
      'hash-1',
      new Date(Date.now() + 60_000),
    );

    expect(first).toMatchObject({
      status: 'PROCESSING',
      resource_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    expect(first?.processing_expires_at).not.toBeNull();
    expect(second).toBeNull();
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

  it('rejects unauthenticated invalid requests before validation and does not create an idempotency record', async () => {
    const response = await request(createApp())
      .post('/internal/payments')
      .set('idempotency-key', 'idem-unauthenticated-invalid')
      .send({
        merchantId,
        amountMinor: 10.5,
        currency: 'TRY',
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');

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

  it('preserves cached idempotency response status code on replay', async () => {
    const body = {
      merchantId,
      amountMinor: 1000,
      currency: 'TRY',
    };
    const cachedPayment = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      merchantId,
      amountMinor: 1000,
      currency: 'TRY',
      status: 'AUTHORIZED',
      provider: 'integration-provider',
      providerPaymentId: 'provider_payment_1',
      failureCode: null,
      failureMessage: null,
      createdAt: '2026-07-09T10:00:00.000Z',
    };
    const provider = createProviderRegistryMock();

    await knex('idempotency_keys').insert({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-replay-status',
      request_hash: buildRequestHash(body),
      status: 'COMPLETED',
      resource_type: 'payment',
      resource_id: cachedPayment.id,
      response_status_code: 202,
      response_body: cachedPayment,
      expires_at: new Date(Date.now() + 60_000),
    });

    const response = await request(createApp(provider.registry))
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-replay-status')
      .send(body);

    expect(response.status).toBe(202);
    expect(response.body).toEqual(cachedPayment);
    expect(provider.authorize).not.toHaveBeenCalled();
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
      processing_expires_at: new Date(Date.now() + 60_000),
    });

    const response = await request(createApp())
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-processing')
      .send(body);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
  });

  it('takes over an expired processing record and preserves the reserved payment id', async () => {
    const reservedPaymentId = '33333333-3333-4333-8333-333333333333';
    const body = {
      merchantId,
      amountMinor: 1000,
      currency: 'TRY',
    };

    await knex('idempotency_keys').insert({
      id: '44444444-4444-4444-8444-444444444444',
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-expired-processing',
      request_hash: buildRequestHash(body),
      status: 'PROCESSING',
      resource_type: 'payment',
      resource_id: reservedPaymentId,
      processing_expires_at: new Date(Date.now() - 1000),
    });

    const response = await request(createApp())
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-expired-processing')
      .send(body);

    expect(response.status).toBe(201);
    expect(response.body.id).toBe(reservedPaymentId);

    const record = await knex('idempotency_keys')
      .where({ idempotency_key: 'idem-expired-processing' })
      .first();
    expect(record.status).toBe('COMPLETED');
    expect(record.resource_id).toBe(reservedPaymentId);
    expect(record.expires_at).not.toBeNull();
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

  it('sets retention expiry when an unexpected create error marks idempotency failed', async () => {
    const failingProvider = {
      getDefaultProvider: jest.fn().mockReturnValue({
        authorize: jest.fn().mockRejectedValue(new Error('provider unavailable')),
        capture: jest.fn(),
      }),
    };

    const response = await request(createApp(failingProvider))
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-provider-error')
      .send({
        merchantId,
        amountMinor: 1000,
        currency: 'TRY',
      });

    expect(response.status).toBe(500);

    const record = await knex('idempotency_keys')
      .where({ idempotency_key: 'idem-provider-error' })
      .first();
    expect(record.status).toBe('FAILED');
    expect(record.expires_at).not.toBeNull();
  });

  it('does not expose internal OpenAPI docs unless explicitly enabled', async () => {
    await request(createApp()).get('/internal-docs.json').expect(404);
  });

  it('exposes internal OpenAPI docs when explicitly enabled', async () => {
    const response = await request(createApp(createProviderRegistryMock().registry, {
      OPENAPI_DOCS_ENABLED: 'true',
    }))
      .get('/internal-docs.json')
      .expect(200);

    expect(response.body.openapi).toMatch(/^3\.0\./);
    expect(response.body.info).toEqual(expect.objectContaining({
      title: 'payment-service-test Internal API',
    }));
  });
});
