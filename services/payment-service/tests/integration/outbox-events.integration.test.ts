import { asValue } from 'awilix';
import knexFactory, { Knex } from 'knex';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { buildContainer } from '../../src/bootstrap/container';
import * as createPaymentsMigration from '../../src/bootstrap/knex/migrations/001_create_payments';
import * as createIdempotencyKeysMigration from '../../src/bootstrap/knex/migrations/002_create_idempotency_keys';
import * as addIdempotencyLeaseMetadata from '../../src/bootstrap/knex/migrations/003_add_idempotency_lease_metadata';
import * as hardenPaymentIntegrity from '../../src/bootstrap/knex/migrations/004_harden_payment_integrity';
import * as addIdempotencyProcessingToken from '../../src/bootstrap/knex/migrations/005_add_idempotency_processing_token';
import * as createOutboxEventsMigration from '../../src/bootstrap/knex/migrations/006_create_outbox_events';
import type { TransactionContext } from '../../src/data-access/transaction-manager';

const postgresUser = 'outbox_test';
const postgresPassword = 'outbox_test';
const postgresDatabase = 'outbox_test';

interface OutboxRecord {
  id: string;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  attempts: number;
  next_retry_at: Date | string | null;
  last_error: string | null;
  published_at: Date | string | null;
}

interface OutboxEventsDataAccessContract {
  insertPending(event: Record<string, unknown>, trx: TransactionContext): Promise<OutboxRecord>;
  fetchPendingBatch(limit: number, trx: TransactionContext): Promise<OutboxRecord[]>;
  markPublished(id: string, trx: TransactionContext): Promise<OutboxRecord | null>;
  markPublishFailed(
    input: {
      id: string;
      lastError: string;
      maxAttempts: number;
      nextRetryAt: Date;
    },
    trx: TransactionContext,
  ): Promise<OutboxRecord | null>;
}

function createKnex(connection: string) {
  return knexFactory({
    client: 'pg',
    connection,
    pool: { min: 0, max: 5 },
  });
}

function buildPostgresConnectionUri(container: StartedTestContainer) {
  return `postgres://${postgresUser}:${postgresPassword}@${container.getHost()}:${container.getMappedPort(5432)}/${postgresDatabase}`;
}

describe('OutboxEventsDataAccess PostgreSQL integration', () => {
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

  it('creates the outbox schema, defaults, integrity constraints, and polling index', async () => {
    const columns = await knex('information_schema.columns')
      .select('column_name', 'is_nullable', 'column_default', 'data_type')
      .where({ table_schema: 'public', table_name: 'outbox_events' });
    const byName = new Map(columns.map((column) => [column.column_name, column]));
    const indexes = await knex('pg_indexes')
      .select('indexname', 'indexdef')
      .where({ schemaname: 'public', tablename: 'outbox_events' });

    expect([...byName.keys()]).toEqual(expect.arrayContaining([
      'id',
      'aggregate_type',
      'aggregate_id',
      'event_type',
      'event_version',
      'routing_key',
      'payload',
      'status',
      'attempts',
      'next_retry_at',
      'last_error',
      'created_at',
      'published_at',
    ]));
    expect(byName.get('status')).toMatchObject({
      is_nullable: 'NO',
      column_default: expect.stringContaining('PENDING'),
    });
    expect(byName.get('attempts')).toMatchObject({
      is_nullable: 'NO',
      column_default: expect.stringContaining('0'),
    });
    expect(byName.get('id')).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
    expect(byName.get('aggregate_id')).toMatchObject({
      data_type: 'uuid',
      is_nullable: 'NO',
    });
    expect(byName.get('event_version')).toMatchObject({
      data_type: 'integer',
      is_nullable: 'NO',
    });
    expect(byName.get('payload')).toMatchObject({
      data_type: 'jsonb',
      is_nullable: 'NO',
    });
    expect(byName.get('aggregate_type')).toMatchObject({ is_nullable: 'NO' });
    expect(byName.get('event_type')).toMatchObject({ is_nullable: 'NO' });
    expect(byName.get('routing_key')).toMatchObject({ is_nullable: 'NO' });
    expect(byName.get('created_at')).toMatchObject({ is_nullable: 'NO' });
    expect(indexes.some(({ indexdef }) =>
      indexdef.includes('(status') && indexdef.includes('next_retry_at'))).toBe(true);
    expect(indexes.some(({ indexdef }) =>
      indexdef.includes('(aggregate_type') && indexdef.includes('aggregate_id'))).toBe(true);

    const beforeResult = await knex.raw('SELECT clock_timestamp() AS database_now');
    const beforeInsert = new Date(beforeResult.rows[0].database_now).getTime();
    const defaultedId = '10101010-1010-4010-8010-101010101010';
    const [defaulted] = await knex('outbox_events')
      .insert(buildRawRecord({ id: defaultedId }, false))
      .returning('*');
    const afterResult = await knex.raw('SELECT clock_timestamp() AS database_now');
    const afterInsert = new Date(afterResult.rows[0].database_now).getTime();

    expect(defaulted).toMatchObject({
      id: defaultedId,
      status: 'PENDING',
      attempts: 0,
      created_at: expect.anything(),
    });
    expect(new Date(defaulted.created_at).getTime()).toBeGreaterThanOrEqual(beforeInsert);
    expect(new Date(defaulted.created_at).getTime()).toBeLessThanOrEqual(afterInsert);
    await expect(
      knex('outbox_events').insert(buildRawRecord({ id: defaultedId }, false)),
    ).rejects.toMatchObject({ code: '23505' });

    await expect(insertRaw({ status: 'UNKNOWN' })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRaw({ attempts: -1 })).rejects.toMatchObject({ code: '23514' });
    await expect(insertRaw({ event_version: 0 })).rejects.toMatchObject({ code: '23514' });
    for (const column of ['aggregate_type', 'event_type', 'routing_key']) {
      await expect(insertRaw({ [column]: null })).rejects.toMatchObject({ code: '23502' });
    }
  });

  it('inserts a pending event in the caller transaction and rolls it back with that transaction', async () => {
    await resetOutbox();
    const dataAccess = makeDataAccess();
    const event = buildPendingInput('11111111-1111-4111-8111-111111111111');

    await expect(knex.transaction(async (trx) => {
      const inserted = await dataAccess.insertPending(event, trx);
      expect(inserted).toMatchObject({
        id: event.id,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
        event_type: event.eventType,
        event_version: event.eventVersion,
        routing_key: event.routingKey,
        payload: event.payload,
        status: 'PENDING',
        attempts: 0,
      });
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    await expect(knex('outbox_events').where({ id: event.id }).first()).resolves.toBeUndefined();
  });

  it('fetches only eligible pending events in deterministic created_at and id order with a limit', async () => {
    await resetOutbox();
    const dataAccess = makeDataAccess();
    const now = new Date();
    const sameCreatedAt = new Date(now.getTime() - 20_000);
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const pastRetryId = '00000000-0000-4000-8000-000000000001';
    await insertRaw({
      id: pastRetryId,
      created_at: new Date(now.getTime() - 30_000),
      next_retry_at: new Date(now.getTime() - 1_000),
    });
    await insertRaw({ id: secondId, created_at: sameCreatedAt });
    await insertRaw({ id: firstId, created_at: sameCreatedAt });
    await insertRaw({
      id: '00000000-0000-4000-8000-000000000002',
      created_at: new Date(now.getTime() - 10_000),
    });
    await insertRaw({
      id: '33333333-3333-4333-8333-333333333333',
      next_retry_at: new Date(now.getTime() + 60_000),
    });
    await insertRaw({
      id: '44444444-4444-4444-8444-444444444444',
      status: 'PUBLISHED',
      published_at: now,
    });

    const rows = await knex.transaction((trx) => dataAccess.fetchPendingBatch(3, trx));

    expect(rows.map(({ id }) => id)).toEqual([pastRetryId, firstId, secondId]);
  });

  it('uses SKIP LOCKED so concurrent pollers receive disjoint batches', async () => {
    await resetOutbox();
    const dataAccess = makeDataAccess();
    await Promise.all([
      insertRaw({ id: '11111111-1111-4111-8111-111111111111' }),
      insertRaw({ id: '22222222-2222-4222-8222-222222222222' }),
      insertRaw({ id: '33333333-3333-4333-8333-333333333333' }),
      insertRaw({ id: '44444444-4444-4444-8444-444444444444' }),
    ]);
    const trxA = await knex.transaction();
    const trxB = await knex.transaction();

    try {
      const firstBatch = await dataAccess.fetchPendingBatch(2, trxA);
      const secondBatch = await withTimeout(
        dataAccess.fetchPendingBatch(2, trxB),
        'concurrent outbox poller remained blocked',
      );
      const firstIds = firstBatch.map(({ id }) => id);
      const secondIds = secondBatch.map(({ id }) => id);

      expect(firstIds).toHaveLength(2);
      expect(secondIds).toHaveLength(2);
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
      await trxA.commit();
      await trxB.commit();
    } finally {
      if (!trxA.isCompleted()) {
        await withTimeout(trxA.rollback(), 'first poller rollback timed out')
          .catch(() => undefined);
      }
      if (!trxB.isCompleted()) {
        await withTimeout(trxB.rollback(), 'second poller rollback timed out')
          .catch(() => undefined);
      }
    }
  });

  it('marks only a pending event as published', async () => {
    await resetOutbox();
    const dataAccess = makeDataAccess();
    const id = '11111111-1111-4111-8111-111111111111';
    await insertRaw({ id });

    const updated = await knex.transaction((trx) => dataAccess.markPublished(id, trx));

    expect(updated).toMatchObject({
      id,
      status: 'PUBLISHED',
      published_at: expect.anything(),
    });
  });

  it('increments a pending event attempt and schedules its retry', async () => {
    await resetOutbox();
    const dataAccess = makeDataAccess();
    const id = '11111111-1111-4111-8111-111111111111';
    const nextRetryAt = new Date(Date.now() + 60_000);
    await insertRaw({ id });

    const updated = await knex.transaction((trx) => dataAccess.markPublishFailed({
      id,
      lastError: 'broker confirm failed',
      maxAttempts: 3,
      nextRetryAt,
    }, trx));

    expect(updated).toMatchObject({
      id,
      status: 'PENDING',
      attempts: 1,
      last_error: 'broker confirm failed',
    });
    expect(new Date(updated!.next_retry_at!).getTime()).toBe(nextRetryAt.getTime());
  });

  it('atomically marks the event failed when the next attempt reaches maxAttempts', async () => {
    await resetOutbox();
    const dataAccess = makeDataAccess();
    const id = '11111111-1111-4111-8111-111111111111';
    await insertRaw({ id, attempts: 2 });

    const updated = await knex.transaction((trx) => dataAccess.markPublishFailed({
      id,
      lastError: 'final publish failure',
      maxAttempts: 3,
      nextRetryAt: new Date(Date.now() + 60_000),
    }, trx));

    expect(updated).toMatchObject({
      id,
      status: 'FAILED',
      attempts: 3,
      last_error: 'final publish failure',
      next_retry_at: null,
    });
  });

  it.each([
    ['FAILED', 'markPublished'],
    ['PUBLISHED', 'markPublished'],
    ['PUBLISHED', 'markPublishFailed'],
    ['FAILED', 'markPublishFailed'],
  ] as const)(
    'does not apply %s terminal event transition through %s',
    async (status, operation) => {
      await resetOutbox();
      const dataAccess = makeDataAccess();
      const id = '11111111-1111-4111-8111-111111111111';
      await insertRaw({
        id,
        status,
        attempts: status === 'FAILED' ? 3 : 0,
        published_at: status === 'PUBLISHED' ? new Date() : null,
      });

      const result = await knex.transaction((trx) =>
        operation === 'markPublished'
          ? dataAccess.markPublished(id, trx)
          : dataAccess.markPublishFailed({
            id,
            lastError: 'must not overwrite terminal event',
            maxAttempts: 3,
            nextRetryAt: new Date(Date.now() + 60_000),
          }, trx));
      const stored = await knex('outbox_events').where({ id }).first();

      expect(result).toBeNull();
      expect(stored.status).toBe(status);
      expect(stored.attempts).toBe(status === 'FAILED' ? 3 : 0);
    },
  );

  async function resetOutbox() {
    await knex('outbox_events').del();
  }

  function makeDataAccess(): OutboxEventsDataAccessContract {
    return buildContainer({
      knex: asValue(knex),
    }).resolve<OutboxEventsDataAccessContract>('outboxEventsDataAccess');
  }

  function insertRaw(overrides: Record<string, unknown> = {}) {
    return knex('outbox_events').insert(buildRawRecord(overrides, true));
  }
});

function buildRawRecord(
  overrides: Record<string, unknown> = {},
  includeDefaults: boolean,
) {
  const value = (key: string, fallback: unknown) =>
    Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback;
  const id = value('id', '99999999-9999-4999-8999-999999999999');
  const record: Record<string, unknown> = {
    id,
    aggregate_type: value('aggregate_type', 'payment'),
    aggregate_id: value('aggregate_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    event_type: value('event_type', 'payment.captured.v1'),
    event_version: value('event_version', 1),
    routing_key: value('routing_key', 'payment.captured.v1'),
    payload: value('payload', { eventId: id }),
    next_retry_at: value('next_retry_at', null),
    last_error: value('last_error', null),
    published_at: value('published_at', null),
  };

  if (includeDefaults) {
    record.status = value('status', 'PENDING');
    record.attempts = value('attempts', 0);
    record.created_at = value('created_at', new Date());
  }

  return record;
}

function buildPendingInput(id: string) {
  return {
    id,
    aggregateType: 'payment',
    aggregateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    eventType: 'payment.captured.v1',
    eventVersion: 1,
    routingKey: 'payment.captured.v1',
    payload: {
      eventId: id,
      eventType: 'payment.captured.v1',
      eventVersion: 1,
      source: 'payment-service',
      correlationId: 'trace-outbox-test',
      occurredAt: '2026-07-26T10:00:00.000Z',
      aggregateType: 'payment',
      aggregateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      payload: {},
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
