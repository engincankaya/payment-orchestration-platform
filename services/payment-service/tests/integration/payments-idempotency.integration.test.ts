import { createHash } from 'crypto';

import { asValue } from 'awilix';
import knexFactory, { Knex } from 'knex';
import request from 'supertest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { buildContainer } from '../../src/bootstrap/container';
import * as createPaymentsMigration from '../../src/bootstrap/knex/migrations/001_create_payments';
import * as createIdempotencyKeysMigration from '../../src/bootstrap/knex/migrations/002_create_idempotency_keys';
import * as addIdempotencyLeaseMetadata from '../../src/bootstrap/knex/migrations/003_add_idempotency_lease_metadata';
import * as hardenPaymentIntegrity from '../../src/bootstrap/knex/migrations/004_harden_payment_integrity';
import * as addIdempotencyProcessingToken from '../../src/bootstrap/knex/migrations/005_add_idempotency_processing_token';
import IdempotencyDataAccess from '../../src/data-access/idempotency/idempotency-data-access';
import { AMOUNT_MINOR_MAX } from '../../src/server/routes/payments/payments';
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

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
    await hardenPaymentIntegrity.up(knex);
    await addIdempotencyProcessingToken.up(knex);
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
      processingToken: '11111111-1111-4111-8111-111111111111',
    });
    const second = await dataAccess.tryInsertProcessing({
      scope: `payments:create:${merchantId}`,
      idempotencyKey: 'idem-data-access-conflict',
      requestHash: 'hash-1',
      resource: { type: 'payment', id: '66666666-6666-4666-8666-666666666666' },
      processingExpiresAt: new Date(Date.now() + 60_000),
      processingToken: '22222222-2222-4222-8222-222222222222',
    });

    expect(first).toMatchObject({
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-data-access-conflict',
      status: 'PROCESSING',
      processing_token: '11111111-1111-4111-8111-111111111111',
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
      processingToken: '33333333-3333-4333-8333-333333333333',
    });
    const second = await dataAccess.tryInsertProcessing({
      scope: 'payments:create:22222222-2222-4222-8222-222222222222',
      idempotencyKey: 'idem-data-access-scope',
      requestHash: 'hash-1',
      resource: { type: 'payment', id: '88888888-8888-4888-8888-888888888888' },
      processingExpiresAt: new Date(Date.now() + 60_000),
      processingToken: '44444444-4444-4444-8444-444444444444',
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
      processing_token: '55555555-5555-4555-8555-555555555555',
    });

    const record = await dataAccess.reactivateFailed(
      '99999999-9999-4999-8999-999999999999',
      'hash-1',
      newLease,
      '66666666-6666-4666-8666-666666666666',
    );

    expect(record).toMatchObject({
      status: 'PROCESSING',
      resource_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      processing_token: '66666666-6666-4666-8666-666666666666',
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
      processing_token: '77777777-7777-4777-8777-777777777777',
    });

    const first = await dataAccess.takeoverExpiredProcessing(
      idempotencyRecordId,
      'hash-1',
      new Date(Date.now() + 60_000),
      '88888888-8888-4888-8888-888888888888',
    );
    const second = await dataAccess.takeoverExpiredProcessing(
      idempotencyRecordId,
      'hash-1',
      new Date(Date.now() + 60_000),
      '99999999-9999-4999-8999-999999999999',
    );

    expect(first).toMatchObject({
      status: 'PROCESSING',
      resource_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      processing_token: '88888888-8888-4888-8888-888888888888',
    });
    expect(first?.processing_expires_at).not.toBeNull();
    expect(second).toBeNull();
  });

  it('allows only the current PROCESSING token to mark a record COMPLETED', async () => {
    const dataAccess = createTestContainer().resolve<IdempotencyDataAccess>(
      'idempotencyDataAccess',
    );
    const id = '12121212-1212-4212-8212-121212121212';
    const currentToken = '13131313-1313-4313-8313-131313131313';

    await knex('idempotency_keys').insert({
      id,
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-completion-fencing',
      request_hash: 'hash-1',
      status: 'PROCESSING',
      resource_type: 'payment',
      resource_id: '14141414-1414-4414-8414-141414141414',
      processing_token: currentToken,
    });

    const staleResult = await dataAccess.markCompleted({
      id,
      processingToken: '15151515-1515-4515-8515-151515151515',
      responseStatusCode: 201,
      responseBody: { id: '14141414-1414-4414-8414-141414141414' },
      resourceType: 'payment',
      resourceId: '14141414-1414-4414-8414-141414141414',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const afterStaleWrite = await knex('idempotency_keys').where({ id }).first();
    const currentResult = await dataAccess.markCompleted({
      id,
      processingToken: currentToken,
      responseStatusCode: 201,
      responseBody: { id: '14141414-1414-4414-8414-141414141414' },
      resourceType: 'payment',
      resourceId: '14141414-1414-4414-8414-141414141414',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const terminalRewrite = await dataAccess.markFailed({
      id,
      processingToken: currentToken,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const afterTerminalRewrite = await knex('idempotency_keys').where({ id }).first();

    expect(staleResult).toBeNull();
    expect(afterStaleWrite).toMatchObject({
      status: 'PROCESSING',
      processing_token: currentToken,
    });
    expect(currentResult).toMatchObject({
      status: 'COMPLETED',
      processing_token: currentToken,
    });
    expect(terminalRewrite).toBeNull();
    expect(afterTerminalRewrite).toMatchObject({
      status: 'COMPLETED',
      processing_token: currentToken,
    });
  });

  it('allows only the current PROCESSING token to mark a record FAILED', async () => {
    const dataAccess = createTestContainer().resolve<IdempotencyDataAccess>(
      'idempotencyDataAccess',
    );
    const id = '16161616-1616-4616-8616-161616161616';
    const currentToken = '17171717-1717-4717-8717-171717171717';

    await knex('idempotency_keys').insert({
      id,
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-failure-fencing',
      request_hash: 'hash-1',
      status: 'PROCESSING',
      resource_type: 'payment',
      resource_id: '18181818-1818-4818-8818-181818181818',
      processing_token: currentToken,
    });

    const staleResult = await dataAccess.markFailed({
      id,
      processingToken: '19191919-1919-4919-8919-191919191919',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const afterStaleWrite = await knex('idempotency_keys').where({ id }).first();
    const currentResult = await dataAccess.markFailed({
      id,
      processingToken: currentToken,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const terminalRewrite = await dataAccess.markCompleted({
      id,
      processingToken: currentToken,
      responseStatusCode: 201,
      responseBody: { id: '18181818-1818-4818-8818-181818181818' },
      resourceType: 'payment',
      resourceId: '18181818-1818-4818-8818-181818181818',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const afterTerminalRewrite = await knex('idempotency_keys').where({ id }).first();

    expect(staleResult).toBeNull();
    expect(afterStaleWrite).toMatchObject({
      status: 'PROCESSING',
      processing_token: currentToken,
    });
    expect(currentResult).toMatchObject({
      status: 'FAILED',
      processing_token: currentToken,
    });
    expect(terminalRewrite).toBeNull();
    expect(afterTerminalRewrite).toMatchObject({
      status: 'FAILED',
      processing_token: currentToken,
    });
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

  it('rejects payment create when amountMinor is above the maximum', async () => {
    const response = await request(createApp())
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-amount-max-rejected')
      .send({
        merchantId,
        amountMinor: AMOUNT_MINOR_MAX + 1,
        currency: 'TRY',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
    });
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'body.amountMinor',
        }),
      ]),
    );

    const count = await knex('idempotency_keys').count<{ count: string }[]>('* as count');
    expect(Number(count[0].count)).toBe(0);
  });

  it('accepts payment create when amountMinor is exactly the maximum', async () => {
    const response = await request(createApp())
      .post('/internal/payments')
      .set('x-internal-token', internalToken)
      .set('idempotency-key', 'idem-amount-max-accepted')
      .send({
        merchantId,
        amountMinor: AMOUNT_MINOR_MAX,
        currency: 'TRY',
      });

    expect(response.status).toBe(201);
    expect(response.body.amountMinor).toBe(AMOUNT_MINOR_MAX);
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
      processing_token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
      processing_token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
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
      processing_token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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

  it('rejects invalid payment values at the database boundary', async () => {
    await expect(
      insertPaymentRaw({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'UNKNOWN' }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertPaymentRaw({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', currency: 'GBP' }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertPaymentRaw({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', amount_minor: 0 }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows the full spec payment lifecycle values at the database boundary', async () => {
    await insertPaymentRaw({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'CREATED' });
    await insertPaymentRaw({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'AUTHORIZED' });
    await insertPaymentRaw({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'CAPTURED' });
    await insertPaymentRaw({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'FAILED' });
    await insertPaymentRaw({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', status: 'CAPTURE_FAILED' });

    const count = await knex('payments').count<{ count: string }[]>('* as count');
    expect(Number(count[0].count)).toBe(5);
  });

  it('rejects invalid idempotency statuses at the database boundary', async () => {
    await expect(
      knex('idempotency_keys').insert({
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        scope: `payments:create:${merchantId}`,
        idempotency_key: 'idem-invalid-status',
        request_hash: 'hash-1',
        status: 'UNKNOWN',
        processing_token: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('updates payments updated_at through the database trigger', async () => {
    await insertPaymentRaw({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const before = await knex('payments')
      .where({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
      .first();

    await wait(10);
    await knex.raw('UPDATE payments SET provider_payment_id = ? WHERE id = ?', [
      'provider_payment_updated',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]);

    const after = await knex('payments')
      .where({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
      .first();
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });

  it('updates idempotency updated_at through the database trigger', async () => {
    await knex('idempotency_keys').insert({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      scope: `payments:create:${merchantId}`,
      idempotency_key: 'idem-trigger-updated-at',
      request_hash: 'hash-1',
      status: 'PROCESSING',
      processing_token: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });
    const before = await knex('idempotency_keys')
      .where({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
      .first();

    await wait(10);
    await knex.raw('UPDATE idempotency_keys SET status = ? WHERE id = ?', [
      'FAILED',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ]);

    const after = await knex('idempotency_keys')
      .where({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
      .first();
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });

  function insertPaymentRaw(overrides: Record<string, unknown> = {}) {
    return knex('payments').insert({
      id: overrides.id ?? '99999999-9999-4999-8999-999999999999',
      merchant_id: merchantId,
      amount_minor: overrides.amount_minor ?? 1000,
      currency: overrides.currency ?? 'TRY',
      status: overrides.status ?? 'AUTHORIZED',
      provider: 'integration-provider',
      provider_payment_id: null,
      failure_code: null,
      failure_message: null,
    });
  }
});
