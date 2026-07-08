import { createHash } from 'crypto';
import { Knex } from 'knex';

import IdempotencyDataAccess, {
  IdempotencyRecord,
  IdempotencyStatus,
} from '../../data-access/idempotency/idempotency-data-access';
import ApiError from '../../types/errors/api-error';

export type IdempotencyDataAccessPort = Pick<
  IdempotencyDataAccess,
  'findByScopeAndKey' | 'tryInsertProcessing' | 'reactivateFailed' | 'markCompleted' | 'markFailed'
>;

export type IdempotencyDecision =
  | { type: 'STARTED'; recordId: string }
  | { type: 'COMPLETED'; responseStatusCode: number; responseBody: unknown };

export default class IdempotencyService {
  private idempotencyDataAccess: IdempotencyDataAccessPort;

  constructor(deps: { idempotencyDataAccess: IdempotencyDataAccessPort }) {
    this.idempotencyDataAccess = deps.idempotencyDataAccess;
  }

  public buildRequestHash = (body: unknown) => {
    const canonicalBody = JSON.stringify(this.canonicalize(body));
    return createHash('sha256').update(canonicalBody).digest('hex');
  };

  public getExistingOrStart = async (input: {
    scope: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<IdempotencyDecision> => {
    const existing = await this.idempotencyDataAccess.findByScopeAndKey(
      input.scope,
      input.idempotencyKey,
    );

    if (existing) {
      return this.decideFromExisting(existing, input.requestHash);
    }

    const inserted = await this.idempotencyDataAccess.tryInsertProcessing(input);

    if (inserted) {
      return { type: 'STARTED', recordId: inserted.id };
    }

    const recordAfterConflict = await this.idempotencyDataAccess.findByScopeAndKey(
      input.scope,
      input.idempotencyKey,
    );

    if (!recordAfterConflict) {
      throw new ApiError({
        code: 'IDEMPOTENCY_STATE_NOT_FOUND',
        message: 'Idempotency state could not be resolved',
        statusCode: 500,
        isOperational: false,
      });
    }

    return this.decideFromExisting(recordAfterConflict, input.requestHash);
  };

  public markCompleted = async (input: {
    idempotencyRecordId: string;
    responseStatusCode: number;
    responseBody: unknown;
    resourceType: string;
    resourceId: string;
    trx?: Knex.Transaction;
  }) => {
    return this.idempotencyDataAccess.markCompleted({
      id: input.idempotencyRecordId,
      responseStatusCode: input.responseStatusCode,
      responseBody: input.responseBody,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    }, input.trx);
  };

  public markFailed = async (input: {
    idempotencyRecordId: string;
    trx?: Knex.Transaction;
  }) => {
    return this.idempotencyDataAccess.markFailed(input.idempotencyRecordId, input.trx);
  };

  private decideFromExisting = async (
    record: IdempotencyRecord,
    requestHash: string,
  ): Promise<IdempotencyDecision> => {
    if (record.request_hash !== requestHash) {
      throw new ApiError({
        code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
        message: 'Idempotency key was reused with a different request',
        statusCode: 409,
      });
    }

    if (record.status === IdempotencyStatus.COMPLETED) {
      return {
        type: 'COMPLETED',
        responseStatusCode: Number(record.response_status_code),
        responseBody: this.normalizeResponseBody(record.response_body),
      };
    }

    if (record.status === IdempotencyStatus.FAILED) {
      const reactivated = await this.idempotencyDataAccess.reactivateFailed(
        record.id,
        requestHash,
      );

      if (reactivated) {
        return { type: 'STARTED', recordId: reactivated.id };
      }
    }

    throw new ApiError({
      code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      message: 'An idempotent request with the same key is already in progress',
      statusCode: 409,
    });
  };

  private normalizeResponseBody(responseBody: unknown) {
    if (typeof responseBody !== 'string') {
      return responseBody;
    }

    try {
      return JSON.parse(responseBody);
    } catch {
      return responseBody;
    }
  }

  private canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalize(item));
    }

    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          result[key] = this.canonicalize((value as Record<string, unknown>)[key]);
          return result;
        }, {});
    }

    return value;
  }
}
