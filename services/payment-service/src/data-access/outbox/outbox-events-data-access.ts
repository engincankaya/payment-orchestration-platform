import type { Knex } from 'knex';

import BaseDataAccess from '../base-data-access';
import type { TransactionContext } from '../transaction-manager';

export type OutboxEventStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

export interface OutboxEventRecord {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  routing_key: string;
  payload: Record<string, unknown>;
  status: OutboxEventStatus;
  attempts: number;
  next_retry_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  published_at: Date | string | null;
}

export interface InsertPendingOutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  routingKey: string;
  payload: Record<string, unknown>;
}

export interface MarkPublishFailedInput {
  id: string;
  lastError: string;
  maxAttempts: number;
  nextRetryAt: Date;
}

export default class OutboxEventsDataAccess extends BaseDataAccess<OutboxEventRecord> {
  constructor(deps: { knex: Knex }) {
    super(deps, 'outbox_events');
  }

  /** Inserts a pending event using the caller's transaction. */
  public insertPending = async (
    event: InsertPendingOutboxEvent,
    trx: TransactionContext,
  ) => {
    const [record] = await this.query(trx)
      .insert({
        id: event.id,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
        event_type: event.eventType,
        event_version: event.eventVersion,
        routing_key: event.routingKey,
        payload: event.payload,
      })
      .returning('*');

    return record;
  };

  /** Locks an ordered batch of eligible pending events without waiting on other pollers. */
  public fetchPendingBatch = async (
    limit: number,
    trx: TransactionContext,
  ) => {
    return this.query(trx)
      .where({ status: 'PENDING' })
      .andWhere((query) => {
        query
          .whereNull('next_retry_at')
          .orWhere('next_retry_at', '<=', trx.fn.now());
      })
      .orderBy([
        { column: 'created_at', order: 'asc' },
        { column: 'id', order: 'asc' },
      ])
      .limit(limit)
      .forUpdate()
      .skipLocked();
  };

  /** Marks an event published only while it is pending. */
  public markPublished = async (
    id: string,
    trx: TransactionContext,
  ) => {
    const [record] = await this.query(trx)
      .where({ id, status: 'PENDING' })
      .update({
        status: 'PUBLISHED',
        published_at: trx.fn.now(),
      })
      .returning('*');

    return record ?? null;
  };

  /** Records a publish failure and atomically fences the terminal attempt. */
  public markPublishFailed = async (
    input: MarkPublishFailedInput,
    trx: TransactionContext,
  ) => {
    const reachesTerminalAttempt = 'attempts + 1 >= ?';
    const [record] = await this.query(trx)
      .where({ id: input.id, status: 'PENDING' })
      .update({
        attempts: trx.raw('attempts + 1'),
        status: trx.raw(
          `CASE WHEN ${reachesTerminalAttempt} THEN 'FAILED' ELSE 'PENDING' END`,
          [input.maxAttempts],
        ),
        next_retry_at: trx.raw(
          `CASE WHEN ${reachesTerminalAttempt} THEN NULL ELSE ?::timestamptz END`,
          [input.maxAttempts, input.nextRetryAt],
        ),
        last_error: input.lastError,
      })
      .returning('*');

    return record ?? null;
  };
}
