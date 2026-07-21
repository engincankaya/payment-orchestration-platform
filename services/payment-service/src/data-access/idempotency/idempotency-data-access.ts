import { randomUUID } from 'crypto';
import { Knex } from 'knex';

import BaseDataAccess from '../base-data-access';

export const IdempotencyStatus = {
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type IdempotencyStatusValue =
  (typeof IdempotencyStatus)[keyof typeof IdempotencyStatus];

export interface IdempotencyRecord {
  id: string;
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: IdempotencyStatusValue;
  resource_type?: string | null;
  resource_id?: string | null;
  response_status_code?: number | null;
  response_body?: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at?: Date | string | null;
  processing_expires_at?: Date | string | null;
}

export interface TryInsertProcessingInput {
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  resource: {
    type: string;
    id: string;
  };
  processingExpiresAt: Date;
}

export default class IdempotencyDataAccess extends BaseDataAccess<IdempotencyRecord> {
  constructor(deps: { knex: Knex }) {
    super(deps, 'idempotency_keys');
  }

  public findByScopeAndKey = async (
    scope: string,
    idempotencyKey: string,
    trx?: Knex.Transaction,
  ) => {
    return this.query(trx)
      .where({ scope, idempotency_key: idempotencyKey })
      .first();
  };

  public tryInsertProcessing = async (
    input: TryInsertProcessingInput,
    trx?: Knex.Transaction,
  ) => {
    const [record] = await this.query(trx)
      .insert({
        id: randomUUID(),
        scope: input.scope,
        idempotency_key: input.idempotencyKey,
        request_hash: input.requestHash,
        status: IdempotencyStatus.PROCESSING,
        // Reserved at PROCESSING time so retries keep the same provider-facing payment id.
        resource_type: input.resource.type,
        resource_id: input.resource.id,
        processing_expires_at: input.processingExpiresAt,
      })
      .onConflict(['scope', 'idempotency_key'])
      .ignore()
      .returning('*');

    return record ?? null;
  };

  public reactivateFailed = async (
    id: string,
    requestHash: string,
    processingExpiresAt: Date,
    trx?: Knex.Transaction,
  ) => {
    const [record] = await this.query(trx)
      .where({
        id,
        request_hash: requestHash,
        status: IdempotencyStatus.FAILED,
      })
      .update({
        status: IdempotencyStatus.PROCESSING,
        processing_expires_at: processingExpiresAt,
        updated_at: this.knex.fn.now(),
      })
      .returning('*');

    return record ?? null;
  };

  public takeoverExpiredProcessing = async (
    id: string,
    requestHash: string,
    processingExpiresAt: Date,
    trx?: Knex.Transaction,
  ) => {
    const [record] = await this.query(trx)
      .where({
        id,
        request_hash: requestHash,
        status: IdempotencyStatus.PROCESSING,
      })
      .where('processing_expires_at', '<', this.knex.fn.now())
      .update({
        processing_expires_at: processingExpiresAt,
        updated_at: this.knex.fn.now(),
      })
      .returning('*');

    return record ?? null;
  };

  public markCompleted = async (
    input: {
      id: string;
      responseStatusCode: number;
      responseBody: unknown;
      resourceType: string;
      resourceId: string;
      expiresAt: Date;
    },
    trx?: Knex.Transaction,
  ) => {
    const [record] = await this.query(trx)
      .where({ id: input.id })
      .update({
        status: IdempotencyStatus.COMPLETED,
        response_status_code: input.responseStatusCode,
        response_body: input.responseBody,
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        expires_at: input.expiresAt,
        updated_at: this.knex.fn.now(),
      })
      .returning('*');

    return record ?? null;
  };

  public markFailed = async (id: string, expiresAt: Date, trx?: Knex.Transaction) => {
    const [record] = await this.query(trx)
      .where({ id })
      .update({
        status: IdempotencyStatus.FAILED,
        expires_at: expiresAt,
        updated_at: this.knex.fn.now(),
      })
      .returning('*');

    return record ?? null;
  };
}
