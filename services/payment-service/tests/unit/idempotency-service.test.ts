import IdempotencyService, {
  IdempotencyDataAccessPort,
} from '../../src/services/idempotency/idempotency-service';

const makeDataAccessMock = (
  overrides: Partial<jest.Mocked<IdempotencyDataAccessPort>> = {},
): jest.Mocked<IdempotencyDataAccessPort> => ({
  findByScopeAndKey: jest.fn().mockResolvedValue(null),
  tryInsertProcessing: jest.fn().mockResolvedValue(null),
  reactivateFailed: jest.fn().mockResolvedValue(null),
  markCompleted: jest.fn().mockResolvedValue(null),
  markFailed: jest.fn().mockResolvedValue(null),
  ...overrides,
});

const makeService = (idempotencyDataAccess = makeDataAccessMock()) =>
  new IdempotencyService({ idempotencyDataAccess });

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
    const tryInsertProcessing = jest.fn().mockResolvedValue({
      id: 'idem-1',
      status: 'PROCESSING',
    });
    const service = makeService(makeDataAccessMock({
      findByScopeAndKey: jest.fn().mockResolvedValue(null),
      tryInsertProcessing,
    }));

    await expect(
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-1',
      }),
    ).resolves.toEqual({ type: 'STARTED', recordId: 'idem-1' });

    expect(tryInsertProcessing).toHaveBeenCalledWith({
      scope: 'payments:create:merchant-1',
      idempotencyKey: 'idem-key-1',
      requestHash: 'hash-1',
    });
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
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
    });
    expect(tryInsertProcessing).not.toHaveBeenCalled();
  });

  it('reactivates a failed idempotency record only when the request hash matches', async () => {
    const reactivateFailed = jest.fn().mockResolvedValue({
      id: 'idem-1',
      request_hash: 'hash-1',
      status: 'PROCESSING',
    });
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
        requestHash: 'hash-1',
      }),
    ).resolves.toEqual({ type: 'STARTED', recordId: 'idem-1' });

    expect(reactivateFailed).toHaveBeenCalledWith('idem-1', 'hash-1');
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
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
    expect(reactivateFailed).not.toHaveBeenCalled();
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
      }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'IDEMPOTENCY_STATE_NOT_FOUND',
    });
  });
});
