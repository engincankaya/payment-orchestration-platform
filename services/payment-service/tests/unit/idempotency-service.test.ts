import type { TransactionContext } from '../../src/data-access/transaction-manager';
import IdempotencyService, {
  IdempotencyDataAccessPort,
} from '../../src/services/idempotency/idempotency-service';

const makeDataAccessMock = (
  overrides: Partial<jest.Mocked<IdempotencyDataAccessPort>> = {},
): jest.Mocked<IdempotencyDataAccessPort> => ({
  findByScopeAndKey: jest.fn().mockResolvedValue(null),
  tryInsertProcessing: jest.fn().mockResolvedValue(null),
  reactivateFailed: jest.fn().mockResolvedValue(null),
  takeoverExpiredProcessing: jest.fn().mockResolvedValue(null),
  markCompleted: jest.fn().mockResolvedValue(null),
  markFailed: jest.fn().mockResolvedValue(null),
  ...overrides,
});

const makeService = (idempotencyDataAccess = makeDataAccessMock()) =>
  new IdempotencyService({ idempotencyDataAccess });

const paymentResource = { type: 'payment', id: 'payment-1' };
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

describe('IdempotencyService', () => {
  it('buildRequestHash returns the same hash for the same body with different key order', () => {
    const service = makeService();

    expect(service.buildRequestHash({ a: 1, b: 2 })).toBe(
      service.buildRequestHash({ b: 2, a: 1 }),
    );
  });

  it('buildRequestHash recursively sorts nested object keys', () => {
    const service = makeService();

    expect(
      service.buildRequestHash({ merchant: { id: 'm-1', country: 'TR' }, amount: 100 }),
    ).toBe(
      service.buildRequestHash({ amount: 100, merchant: { country: 'TR', id: 'm-1' } }),
    );
  });

  it('buildRequestHash changes when a value changes', () => {
    const service = makeService();

    expect(service.buildRequestHash({ amountMinor: 1000, currency: 'TRY' })).not.toBe(
      service.buildRequestHash({ amountMinor: 1001, currency: 'TRY' }),
    );
  });

  it('buildRequestHash returns a lowercase SHA-256 hex string', () => {
    const service = makeService();

    expect(service.buildRequestHash({ amountMinor: 1000, currency: 'TRY' })).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('starts a new idempotency record when scope and key are unseen', async () => {
    const tryInsertProcessing = jest.fn().mockImplementation(
      async (input: { processingToken: string }) => ({
        id: 'idem-1',
        resource_id: 'payment-1',
        processing_token: input.processingToken,
        status: 'PROCESSING',
      }),
    );
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue(null),
      tryInsertProcessing,
    }));

    const decision = await service.getExistingOrStart({
      scope: 'payments:create:merchant-1',
      idempotencyKey: 'idem-key-1',
      requestHash: 'hash-1',
      resource: { type: 'payment', id: 'payment-1' },
    });
    const insertedProcessingToken = tryInsertProcessing.mock.calls[0][0].processingToken;

    expect(insertedProcessingToken).toMatch(UUID_PATTERN);
    expect(decision).toEqual({
      type: 'STARTED',
      recordId: 'idem-1',
      resourceId: 'payment-1',
      processingToken: insertedProcessingToken,
    });
    expect(tryInsertProcessing).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-1',
        resource: { type: 'payment', id: 'payment-1' },
        processingExpiresAt: expect.any(Date),
        processingToken: expect.stringMatching(UUID_PATTERN),
      }),
    );
  });

  it('returns cached response for same scope, key, and request hash', async () => {
    const cachedBody = { id: 'payment-1', status: 'AUTHORIZED' };
    const tryInsertProcessing = jest.fn();
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue({
        id: 'idem-1',
        scope: 'payments:create:merchant-1',
        idempotency_key: 'idem-key-1',
        request_hash: 'hash-1',
        status: 'COMPLETED',
        response_status_code: 201,
        response_body: cachedBody,
      }),
      tryInsertProcessing,
    }));

    await expect(
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-1',
        resource: paymentResource,
      }),
    ).resolves.toEqual({
      type: 'COMPLETED',
      responseStatusCode: 201,
      responseBody: cachedBody,
    });
    expect(tryInsertProcessing).not.toHaveBeenCalled();
  });

  it('rejects same scope and key reused with a different request hash', async () => {
    const tryInsertProcessing = jest.fn();
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue({
        id: 'idem-1',
        request_hash: 'hash-1',
        status: 'COMPLETED',
      }),
      tryInsertProcessing,
    }));

    await expect(
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-2',
        resource: paymentResource,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
    expect(tryInsertProcessing).not.toHaveBeenCalled();
  });

  it('rejects duplicate request while the original request is still processing', async () => {
    const tryInsertProcessing = jest.fn();
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue({
        id: 'idem-1',
        request_hash: 'hash-1',
        status: 'PROCESSING',
      }),
      tryInsertProcessing,
    }));

    await expect(
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-1',
        resource: paymentResource,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
    });
    expect(tryInsertProcessing).not.toHaveBeenCalled();
  });

  it('reactivates a failed idempotency record only when the request hash matches', async () => {
    const previousToken = '11111111-1111-4111-8111-111111111111';
    const reactivateFailed = jest.fn().mockImplementation(
      async (
        _id: string,
        _requestHash: string,
        _processingExpiresAt: Date,
        nextToken: string,
      ) => ({
        id: 'idem-1',
        request_hash: 'hash-1',
        resource_id: 'payment-1',
        processing_token: nextToken,
        status: 'PROCESSING',
      }),
    );
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue({
        id: 'idem-1',
        request_hash: 'hash-1',
        resource_id: 'payment-1',
        processing_token: previousToken,
        status: 'FAILED',
      }),
      tryInsertProcessing: jest.fn(),
      reactivateFailed,
    }));

    const decision = await service.getExistingOrStart({
      scope: 'payments:create:merchant-1',
      idempotencyKey: 'idem-key-1',
      requestHash: 'hash-1',
      resource: { type: 'payment', id: 'new-payment-id-should-not-be-used' },
    });
    const reactivatedProcessingToken = reactivateFailed.mock.calls[0][3];

    expect(reactivatedProcessingToken).toMatch(UUID_PATTERN);
    expect(reactivatedProcessingToken).not.toBe(previousToken);
    expect(decision).toEqual({
      type: 'STARTED',
      recordId: 'idem-1',
      resourceId: 'payment-1',
      processingToken: reactivatedProcessingToken,
    });
    expect(reactivateFailed).toHaveBeenCalledWith(
      'idem-1',
      'hash-1',
      expect.any(Date),
      expect.stringMatching(UUID_PATTERN),
    );
  });

  it('fails closed when a reactivated record has no reserved resource id', async () => {
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue({
        id: 'idem-1',
        request_hash: 'hash-1',
        resource_id: null,
        status: 'FAILED',
      }),
      reactivateFailed: jest.fn().mockResolvedValue({
        id: 'idem-1',
        request_hash: 'hash-1',
        resource_id: null,
        status: 'PROCESSING',
      }),
    }));

    await expect(
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-1',
        resource: paymentResource,
      }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'IDEMPOTENCY_RESOURCE_MISSING',
    });
  });

  it('rejects a failed idempotency record when the request hash is different', async () => {
    const reactivateFailed = jest.fn();
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue({
        id: 'idem-1',
        request_hash: 'hash-1',
        status: 'FAILED',
      }),
      tryInsertProcessing: jest.fn(),
      reactivateFailed,
    }));

    await expect(
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-2',
        resource: { type: 'payment', id: 'payment-2' },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
    expect(reactivateFailed).not.toHaveBeenCalled();
  });

  it('takes over an expired processing record with the same hash and preserves the resource id', async () => {
    const previousToken = '11111111-1111-4111-8111-111111111111';
    const takeoverExpiredProcessing = jest.fn().mockImplementation(
      async (
        _id: string,
        _requestHash: string,
        _processingExpiresAt: Date,
        nextToken: string,
      ) => ({
        id: 'idem-1',
        request_hash: 'hash-1',
        resource_id: 'payment-1',
        processing_token: nextToken,
        status: 'PROCESSING',
      }),
    );
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue({
        id: 'idem-1',
        request_hash: 'hash-1',
        resource_id: 'payment-1',
        processing_token: previousToken,
        status: 'PROCESSING',
        processing_expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
      tryInsertProcessing: jest.fn(),
      takeoverExpiredProcessing,
    }));

    const decision = await service.getExistingOrStart({
      scope: 'payments:create:merchant-1',
      idempotencyKey: 'idem-key-1',
      requestHash: 'hash-1',
      resource: { type: 'payment', id: 'new-payment-id-should-not-be-used' },
    });
    const takeoverProcessingToken = takeoverExpiredProcessing.mock.calls[0][3];

    expect(takeoverProcessingToken).toMatch(UUID_PATTERN);
    expect(takeoverProcessingToken).not.toBe(previousToken);
    expect(decision).toEqual({
      type: 'STARTED',
      recordId: 'idem-1',
      resourceId: 'payment-1',
      processingToken: takeoverProcessingToken,
    });
    expect(takeoverExpiredProcessing).toHaveBeenCalledWith(
      'idem-1',
      'hash-1',
      expect.any(Date),
      expect.stringMatching(UUID_PATTERN),
    );
  });

  it('rejects an expired processing record when the request hash is different', async () => {
    const takeoverExpiredProcessing = jest.fn();
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue({
        id: 'idem-1',
        request_hash: 'hash-1',
        status: 'PROCESSING',
        processing_expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
      takeoverExpiredProcessing,
    }));

    await expect(
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-2',
        resource: { type: 'payment', id: 'payment-2' },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
    expect(takeoverExpiredProcessing).not.toHaveBeenCalled();
  });

  it('returns cached response even when completed record retention timestamp is expired', async () => {
    const cachedBody = { id: 'payment-1', status: 'AUTHORIZED' };
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue({
        id: 'idem-1',
        request_hash: 'hash-1',
        status: 'COMPLETED',
        response_status_code: 201,
        response_body: cachedBody,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    }));

    await expect(
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-1',
        resource: { type: 'payment', id: 'payment-1' },
      }),
    ).resolves.toEqual({
      type: 'COMPLETED',
      responseStatusCode: 201,
      responseBody: cachedBody,
    });
  });

  it('resolves insert race by re-reading the existing processing record', async () => {
    const findByScopeAndKey = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'idem-1',
        request_hash: 'hash-1',
        status: 'PROCESSING',
      });
    const tryInsertProcessing = jest.fn().mockResolvedValue(null);
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey,
      tryInsertProcessing,
    }));

    await expect(
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-1',
        resource: paymentResource,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
    });

    expect(findByScopeAndKey).toHaveBeenCalledTimes(2);
    expect(tryInsertProcessing).toHaveBeenCalledTimes(1);
  });

  it('fails closed when insert race cannot be resolved by re-reading state', async () => {
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue(null),
      tryInsertProcessing: jest.fn().mockResolvedValue(null),
    }));

    await expect(
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-1',
        resource: paymentResource,
      }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'IDEMPOTENCY_STATE_NOT_FOUND',
    });
  });

  it('passes the ownership token to the conditional COMPLETED write', async () => {
    const markCompleted = jest.fn().mockResolvedValue({
      id: 'idem-1',
      status: 'COMPLETED',
    });
    const service = makeService(makeDataAccessMock({ markCompleted }));
    const trx = { id: 'trx-1' } as unknown as TransactionContext;

    await service.markCompleted({
      idempotencyRecordId: 'idem-1',
      processingToken: '11111111-1111-4111-8111-111111111111',
      responseStatusCode: 200,
      responseBody: { id: 'payment-1', status: 'CAPTURED' },
      resourceType: 'payment',
      resourceId: 'payment-1',
      trx,
    });

    expect(markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'idem-1',
        processingToken: '11111111-1111-4111-8111-111111111111',
        responseStatusCode: 200,
        responseBody: { id: 'payment-1', status: 'CAPTURED' },
        resourceType: 'payment',
        resourceId: 'payment-1',
        expiresAt: expect.any(Date),
      }),
      trx,
    );
  });

  it('passes the ownership token to the conditional FAILED write', async () => {
    const markFailed = jest.fn().mockResolvedValue({
      id: 'idem-1',
      status: 'FAILED',
    });
    const service = makeService(makeDataAccessMock({ markFailed }));
    const trx = { id: 'trx-1' } as unknown as TransactionContext;

    await service.markFailed({
      idempotencyRecordId: 'idem-1',
      processingToken: '11111111-1111-4111-8111-111111111111',
      trx,
    });

    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'idem-1',
        processingToken: '11111111-1111-4111-8111-111111111111',
        expiresAt: expect.any(Date),
      }),
      trx,
    );
  });

  it('throws IDEMPOTENCY_OWNERSHIP_LOST when a stale token completes zero rows', async () => {
    const service = makeService(makeDataAccessMock({
      markCompleted: jest.fn().mockResolvedValue(null),
    }));

    await expect(
      service.markCompleted({
        idempotencyRecordId: 'idem-1',
        processingToken: 'stale-token',
        responseStatusCode: 200,
        responseBody: { id: 'payment-1', status: 'CAPTURED' },
        resourceType: 'payment',
        resourceId: 'payment-1',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_OWNERSHIP_LOST',
      statusCode: 409,
    });
  });

  it('throws IDEMPOTENCY_OWNERSHIP_LOST when a stale token fails zero rows', async () => {
    const service = makeService(makeDataAccessMock({
      markFailed: jest.fn().mockResolvedValue(null),
    }));

    await expect(
      service.markFailed({
        idempotencyRecordId: 'idem-1',
        processingToken: 'stale-token',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_OWNERSHIP_LOST',
      statusCode: 409,
    });
  });

  it('fails fast when lease or retention env values are invalid', () => {
    expect(() => new IdempotencyService({
      idempotencyDataAccess: makeDataAccessMock(),
      env: { IDEMPOTENCY_PROCESSING_LEASE_MS: '0' },
    })).toThrow('IDEMPOTENCY_PROCESSING_LEASE_MS must be a positive number');

    expect(() => new IdempotencyService({
      idempotencyDataAccess: makeDataAccessMock(),
      env: { IDEMPOTENCY_COMPLETED_TTL_MS: 'abc' },
    })).toThrow('IDEMPOTENCY_COMPLETED_TTL_MS must be a positive number');

    expect(() => new IdempotencyService({
      idempotencyDataAccess: makeDataAccessMock(),
      env: { IDEMPOTENCY_FAILED_TTL_MS: '-1' },
    })).toThrow('IDEMPOTENCY_FAILED_TTL_MS must be a positive number');
  });
});
