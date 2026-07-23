import { createHash, randomUUID } from 'crypto';

import IdempotencyDataAccess, {
  IdempotencyRecord,
  IdempotencyStatus,
} from '../../data-access/idempotency/idempotency-data-access';
import type { TransactionContext } from '../../data-access/transaction-manager';
import ApiError from '../../types/errors/api-error';

export type IdempotencyDataAccessPort = Pick<
  IdempotencyDataAccess,
  | 'findByScopeAndKey'
  | 'tryInsertProcessing'
  | 'reactivateFailed'
  | 'takeoverExpiredProcessing'
  | 'markCompleted'
  | 'markFailed'
>;

export type IdempotencyDecision =
  | { type: 'STARTED'; recordId: string; resourceId: string; processingToken: string }
  | { type: 'COMPLETED'; responseStatusCode: number; responseBody: unknown };

export default class IdempotencyService {
  private idempotencyDataAccess: IdempotencyDataAccessPort;
  private processingLeaseMs: number;
  private completedTtlMs: number;
  private failedTtlMs: number;

  constructor(deps: { idempotencyDataAccess: IdempotencyDataAccessPort; env?: NodeJS.ProcessEnv }) {
    this.idempotencyDataAccess = deps.idempotencyDataAccess;
    this.processingLeaseMs = this.parsePositiveNumber(
      deps.env?.IDEMPOTENCY_PROCESSING_LEASE_MS,
      60_000,
      'IDEMPOTENCY_PROCESSING_LEASE_MS',
    );
    this.completedTtlMs = this.parsePositiveNumber(
      deps.env?.IDEMPOTENCY_COMPLETED_TTL_MS,
      86_400_000,
      'IDEMPOTENCY_COMPLETED_TTL_MS',
    );
    this.failedTtlMs = this.parsePositiveNumber(
      deps.env?.IDEMPOTENCY_FAILED_TTL_MS,
      3_600_000,
      'IDEMPOTENCY_FAILED_TTL_MS',
    );
  }

  /** Builds a deterministic hash for an idempotent request payload. */
  public buildRequestHash = (body: unknown) => {
    const canonicalBody = JSON.stringify(this.canonicalize(body));
    return createHash('sha256').update(canonicalBody).digest('hex');
  };

  /** Returns a replayable result or acquires ownership of an idempotent operation. */
  public getExistingOrStart = async (input: {
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    resource: {
      type: string;
      id: string;
    };
  }): Promise<IdempotencyDecision> => {
    const existing = await this.idempotencyDataAccess.findByScopeAndKey(
      input.scope,
      input.idempotencyKey,
    );

    if (existing) {
      return this.decideFromExisting(existing, input.requestHash);
    }

    const processingToken = randomUUID();
    const inserted = await this.idempotencyDataAccess.tryInsertProcessing({
      ...input,
      processingExpiresAt: this.buildProcessingExpiresAt(),
      processingToken,
    });

    if (inserted) {
      return this.buildStartedDecision(inserted);
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

  /** Completes an owned idempotency record using its processing token. */
  public markCompleted = async (input: {
    idempotencyRecordId: string;
    responseStatusCode: number;
    responseBody: unknown;
    resourceType: string;
    resourceId: string;
    processingToken: string;
    trx?: TransactionContext;
  }) => {
    const record = await this.idempotencyDataAccess.markCompleted({
      id: input.idempotencyRecordId,
      responseStatusCode: input.responseStatusCode,
      responseBody: input.responseBody,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expiresAt: this.buildExpiresAt(this.completedTtlMs),
      processingToken: input.processingToken,
    }, input.trx);

    if (!record) {
      throw this.buildOwnershipLostError();
    }

    return record;
  };

  /** Fails an owned idempotency record using its processing token. */
  public markFailed = async (input: {
    idempotencyRecordId: string;
    processingToken: string;
    trx?: TransactionContext;
  }) => {
    const record = await this.idempotencyDataAccess.markFailed(
      {
        id: input.idempotencyRecordId,
        expiresAt: this.buildExpiresAt(this.failedTtlMs),
        processingToken: input.processingToken,
      },
      input.trx,
    );

    if (!record) {
      throw this.buildOwnershipLostError();
    }

    return record;
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
      const processingToken = randomUUID();
      const reactivated = await this.idempotencyDataAccess.reactivateFailed(
        record.id,
        requestHash,
        this.buildProcessingExpiresAt(),
        processingToken,
      );

      if (reactivated) {
        return this.buildStartedDecision(reactivated);
      }
    }

    if (record.status === IdempotencyStatus.PROCESSING && this.isProcessingExpired(record)) {
      const processingToken = randomUUID();
      const reactivated = await this.idempotencyDataAccess.takeoverExpiredProcessing(
        record.id,
        requestHash,
        this.buildProcessingExpiresAt(),
        processingToken,
      );

      if (reactivated) {
        return this.buildStartedDecision(reactivated);
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

  private buildStartedDecision(record: IdempotencyRecord): IdempotencyDecision {
    if (!record.resource_id) {
      throw new ApiError({
        code: 'IDEMPOTENCY_RESOURCE_MISSING',
        message: 'Idempotency resource reference is missing',
        statusCode: 500,
        isOperational: false,
      });
    }

    if (!record.processing_token) {
      throw new ApiError({
        code: 'IDEMPOTENCY_PROCESSING_TOKEN_MISSING',
        message: 'Idempotency processing token is missing',
        statusCode: 500,
        isOperational: false,
      });
    }

    return {
      type: 'STARTED',
      recordId: record.id,
      resourceId: record.resource_id,
      processingToken: record.processing_token,
    };
  }

  private buildOwnershipLostError() {
    return new ApiError({
      code: 'IDEMPOTENCY_OWNERSHIP_LOST',
      message: 'Idempotency ownership was lost',
      statusCode: 409,
    });
  }

  private buildProcessingExpiresAt() {
    return this.buildExpiresAt(this.processingLeaseMs);
  }

  private buildExpiresAt(ttlMs: number) {
    return new Date(Date.now() + ttlMs);
  }

  private isProcessingExpired(record: IdempotencyRecord) {
    if (!record.processing_expires_at) {
      return false;
    }

    return new Date(record.processing_expires_at).getTime() <= Date.now();
  }

  private parsePositiveNumber(value: string | undefined, fallback: number, name: string) {
    const parsed = Number(value ?? fallback);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive number`);
    }

    return parsed;
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
