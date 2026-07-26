import { asValue } from 'awilix';
import knexFactory, { Knex } from 'knex';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { buildContainer } from '../../src/bootstrap/container';
import * as createPaymentsMigration from '../../src/bootstrap/knex/migrations/001_create_payments';
import * as createIdempotencyKeysMigration from '../../src/bootstrap/knex/migrations/002_create_idempotency_keys';
import * as addIdempotencyLeaseMetadata from '../../src/bootstrap/knex/migrations/003_add_idempotency_lease_metadata';
import * as hardenPaymentIntegrity from '../../src/bootstrap/knex/migrations/004_harden_payment_integrity';
import * as addIdempotencyProcessingToken from '../../src/bootstrap/knex/migrations/005_add_idempotency_processing_token';
import PaymentsDataAccess from '../../src/data-access/payments/payments-data-access';

const postgresUser = 'payment_data_access_test';
const postgresPassword = 'payment_data_access_test';
const postgresDatabase = 'payment_data_access_test';
const merchantId = '11111111-1111-4111-8111-111111111111';

function createKnex(connection: string) {
  return knexFactory({
    client: 'pg',
    connection,
    pool: { min: 0, max: 4 },
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

describe('PaymentsDataAccess PostgreSQL integration', () => {
  let postgres: StartedTestContainer;
  let knex: Knex;
  let paymentsDataAccess: PaymentsDataAccess;

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
    paymentsDataAccess = buildContainer({
      knex: asValue(knex),
    }).resolve<PaymentsDataAccess>('paymentsDataAccess');
  }, 120_000);

  afterAll(async () => {
    await knex?.destroy();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await knex('payments').del();
  });

  it('keeps a competing SELECT FOR UPDATE blocked until the owner transaction completes', async () => {
    const paymentId = '22222222-2222-4222-8222-222222222222';
    await insertPayment(paymentId, 'AUTHORIZED');
    const trxA = await knex.transaction();
    const trxB = await knex.transaction();
    const competingQueryStarted = deferred();
    const onQuery = (query: { sql?: string }) => {
      if (query.sql?.toLowerCase().includes('for update')) {
        competingQueryStarted.resolve();
      }
    };

    try {
      await paymentsDataAccess.findByIdForUpdate(paymentId, trxA);
      trxB.on('query', onQuery);

      let competingSettled = false;
      const competingRead = paymentsDataAccess
        .findByIdForUpdate(paymentId, trxB)
        .then((payment) => {
          competingSettled = true;
          return payment;
        });

      await withTimeout(competingQueryStarted.promise, 'competing lock query did not start');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(competingSettled).toBe(false);

      await paymentsDataAccess.updateStatusIfAuthorized({
        id: paymentId,
        status: 'CAPTURED',
        captured_at: new Date('2026-07-26T10:00:00.000Z'),
        failed_at: null,
        failure_code: null,
        failure_message: null,
      }, trxA);
      await trxA.commit();

      await expect(withTimeout(
        competingRead,
        'competing lock query did not resume',
      )).resolves.toMatchObject({
        id: paymentId,
        status: 'CAPTURED',
      });
      await trxB.commit();
    } finally {
      trxB.removeListener('query', onQuery);
      if (!trxA.isCompleted()) {
        await withTimeout(trxA.rollback(), 'owner transaction rollback timed out')
          .catch(() => undefined);
      }
      if (!trxB.isCompleted()) {
        await withTimeout(trxB.rollback(), 'competing transaction rollback timed out')
          .catch(() => undefined);
      }
    }
  });

  it.each(['CREATED', 'CAPTURED', 'FAILED', 'CAPTURE_FAILED'])(
    'does not update a payment whose status is %s',
    async (status) => {
      const paymentId = statusToPaymentId(status);
      await insertPayment(paymentId, status);
      const before = await knex('payments').where({ id: paymentId }).first();

      const result = await knex.transaction((trx) =>
        paymentsDataAccess.updateStatusIfAuthorized({
          id: paymentId,
          status: 'CAPTURED',
          captured_at: new Date('2026-07-26T10:00:00.000Z'),
          failed_at: null,
          failure_code: null,
          failure_message: null,
        }, trx));
      const stored = await knex('payments').where({ id: paymentId }).first();

      expect(result).toBeNull();
      expect(stored.status).toBe(status);
      expect(stored.captured_at).toEqual(before.captured_at);
    },
  );

  function insertPayment(id: string, status: string) {
    return knex('payments').insert({
      id,
      merchant_id: merchantId,
      amount_minor: 1000,
      currency: 'TRY',
      status,
      provider: 'integration-provider',
      provider_payment_id: 'provider-payment-1',
      failure_code: null,
      failure_message: null,
      authorized_at: status === 'AUTHORIZED' ? new Date() : null,
      captured_at: status === 'CAPTURED' ? new Date() : null,
      failed_at: ['FAILED', 'CAPTURE_FAILED'].includes(status) ? new Date() : null,
    });
  }
});

function statusToPaymentId(status: string) {
  const ids: Record<string, string> = {
    CREATED: '33333333-3333-4333-8333-333333333333',
    CAPTURED: '44444444-4444-4444-8444-444444444444',
    FAILED: '55555555-5555-4555-8555-555555555555',
    CAPTURE_FAILED: '66666666-6666-4666-8666-666666666666',
  };
  return ids[status];
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
