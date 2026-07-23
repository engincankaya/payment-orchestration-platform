import knexFactory, { Knex } from 'knex';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import * as createPaymentsMigration from '../../src/bootstrap/knex/migrations/001_create_payments';
import * as createIdempotencyKeysMigration from '../../src/bootstrap/knex/migrations/002_create_idempotency_keys';
import * as addIdempotencyLeaseMetadata from '../../src/bootstrap/knex/migrations/003_add_idempotency_lease_metadata';
import * as hardenPaymentIntegrity from '../../src/bootstrap/knex/migrations/004_harden_payment_integrity';
import * as addIdempotencyProcessingToken from '../../src/bootstrap/knex/migrations/005_add_idempotency_processing_token';

const postgresUser = 'payment_migration_test';
const postgresPassword = 'payment_migration_test';
const postgresDatabase = 'payment_migration_test';
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

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

describe('005_add_idempotency_processing_token migration', () => {
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
  }, 120_000);

  afterAll(async () => {
    await knex?.destroy();
    await postgres?.stop();
  });

  it('backfills legacy rows per row and establishes UUID NOT NULL without a DB default', async () => {
    await knex('idempotency_keys').insert([
      {
        id: '11111111-1111-4111-8111-111111111111',
        scope: 'payments:create:merchant-1',
        idempotency_key: 'legacy-processing',
        request_hash: 'hash-processing',
        status: 'PROCESSING',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        scope: 'payments:create:merchant-1',
        idempotency_key: 'legacy-completed',
        request_hash: 'hash-completed',
        status: 'COMPLETED',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        scope: 'payments:create:merchant-1',
        idempotency_key: 'legacy-failed',
        request_hash: 'hash-failed',
        status: 'FAILED',
      },
    ]);

    await addIdempotencyProcessingToken.up(knex);

    const rows = await knex('idempotency_keys')
      .select('processing_token')
      .orderBy('id');
    const tokens = rows.map((row) => row.processing_token);
    const column = await knex('information_schema.columns')
      .select('data_type', 'is_nullable', 'column_default')
      .where({
        table_schema: 'public',
        table_name: 'idempotency_keys',
        column_name: 'processing_token',
      })
      .first();

    expect(tokens).toHaveLength(3);
    expect(tokens).toEqual(tokens.map(() => expect.stringMatching(UUID_PATTERN)));
    expect(new Set(tokens).size).toBe(3);
    expect(column).toEqual({
      data_type: 'uuid',
      is_nullable: 'NO',
      column_default: null,
    });
    await expect(
      knex('idempotency_keys').insert({
        id: '44444444-4444-4444-8444-444444444444',
        scope: 'payments:create:merchant-1',
        idempotency_key: 'missing-token-after-contract',
        request_hash: 'hash-missing-token',
        status: 'PROCESSING',
      }),
    ).rejects.toMatchObject({ code: '23502' });
  });
});
