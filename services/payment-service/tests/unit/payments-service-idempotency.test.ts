import PaymentsService, {
  IdempotencyServicePort,
  PaymentsDataAccessPort,
  ProviderRegistryServicePort,
} from '../../src/services/payments/payments-service';
import { Logger } from '../../src/utils/logger';

const makePaymentsDataAccessMock = (
  overrides: Partial<jest.Mocked<PaymentsDataAccessPort>> = {},
): jest.Mocked<PaymentsDataAccessPort> => ({
  insert: jest.fn(),
  findById: jest.fn(),
  withTransaction: jest.fn().mockImplementation((handler) => handler({ trx: true })),
  ...overrides,
});

const makeIdempotencyServiceMock = (
  overrides: Partial<jest.Mocked<IdempotencyServicePort>> = {},
): jest.Mocked<IdempotencyServicePort> => ({
  buildRequestHash: jest.fn().mockReturnValue('hash-1'),
  getExistingOrStart: jest.fn().mockResolvedValue({
    type: 'STARTED',
    recordId: 'idem-1',
    resourceId: 'payment-1',
  }),
  markCompleted: jest.fn().mockResolvedValue(null),
  markFailed: jest.fn().mockResolvedValue(null),
  ...overrides,
});

const makeProviderRegistryMock = (
  overrides: Partial<jest.Mocked<ProviderRegistryServicePort>> = {},
): jest.Mocked<ProviderRegistryServicePort> => ({
  getDefaultProvider: jest.fn().mockReturnValue({
    authorize: jest.fn().mockResolvedValue({
      success: true,
      provider: 'mock',
      providerPaymentId: 'provider-payment-1',
    }),
    capture: jest.fn(),
  }),
  ...overrides,
});

const makeLoggerMock = (): jest.Mocked<Logger> => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const makeService = (deps?: {
  paymentsDataAccess?: jest.Mocked<PaymentsDataAccessPort>;
  idempotencyService?: jest.Mocked<IdempotencyServicePort>;
  providerRegistryService?: jest.Mocked<ProviderRegistryServicePort>;
  logger?: jest.Mocked<Logger>;
}) =>
  new PaymentsService({
    paymentsDataAccess: deps?.paymentsDataAccess ?? makePaymentsDataAccessMock(),
    idempotencyService: deps?.idempotencyService ?? makeIdempotencyServiceMock(),
    providerRegistryService: deps?.providerRegistryService ?? makeProviderRegistryMock(),
    logger: deps?.logger ?? makeLoggerMock(),
  });

describe('PaymentsService idempotency', () => {
  it('returns cached payment response and skips provider and payment insert for repeated idempotency request', async () => {
    const cachedPayment = {
      id: 'payment-1',
      merchantId: 'merchant-1',
      amountMinor: 1000,
      currency: 'TRY',
      status: 'AUTHORIZED',
      provider: 'mock',
      providerPaymentId: 'provider-payment-1',
      failureCode: null,
      failureMessage: null,
      createdAt: '2026-07-08T00:00:00.000Z',
    };
    const insert = jest.fn();
    const withTransaction = jest.fn();
    const markCompleted = jest.fn();
    const getDefaultProvider = jest.fn();
    const service = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        insert,
        withTransaction,
      }),
      idempotencyService: makeIdempotencyServiceMock({
        getExistingOrStart: jest.fn().mockResolvedValue({
          type: 'COMPLETED',
          responseStatusCode: 201,
          responseBody: cachedPayment,
        }),
        markCompleted,
      }),
      providerRegistryService: makeProviderRegistryMock({
        getDefaultProvider,
      }),
    });

    await expect(
      service.create({
        correlationId: 'correlation-1',
        idempotencyKey: 'idem-key-1',
        merchantId: 'merchant-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    ).resolves.toEqual(cachedPayment);

    expect(insert).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
    expect(getDefaultProvider).not.toHaveBeenCalled();
  });

  it('stores successful payment response in idempotency record', async () => {
    const trx = { trx: true };
    const authorize = jest.fn().mockResolvedValue({
      success: true,
      provider: 'mock',
      providerPaymentId: 'provider-payment-1',
    });
    const insert = jest.fn().mockImplementation(async (record) => ({
      ...record,
      created_at: '2026-07-08T00:00:00.000Z',
      updated_at: '2026-07-08T00:00:00.000Z',
    }));
    const markCompleted = jest.fn();
    const getExistingOrStart = jest.fn().mockResolvedValue({
      type: 'STARTED',
      recordId: 'idem-1',
      resourceId: 'payment-1',
    });
    const service = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        insert,
        withTransaction: jest.fn().mockImplementation((handler) => handler(trx)),
      }),
      idempotencyService: makeIdempotencyServiceMock({
        getExistingOrStart,
        markCompleted,
      }),
      providerRegistryService: makeProviderRegistryMock({
        getDefaultProvider: jest.fn().mockReturnValue({
          authorize,
          capture: jest.fn(),
        }),
      }),
    });

    const result = await service.create({
      correlationId: 'correlation-1',
      idempotencyKey: 'idem-key-1',
      merchantId: 'merchant-1',
      amountMinor: 1000,
      currency: 'TRY',
    });

    expect(getExistingOrStart).toHaveBeenCalledWith({
      scope: 'payments:create:merchant-1',
      idempotencyKey: 'idem-key-1',
      requestHash: 'hash-1',
      resource: {
        type: 'payment',
        id: expect.any(String),
      },
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 'payment-1',
    }));
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'payment-1',
      }),
      trx,
    );
    expect(markCompleted).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      resourceType: 'payment',
      resourceId: result.id,
      responseStatusCode: 201,
      responseBody: result,
      trx,
    });
  });

  it('stores provider authorization failure response as completed idempotency result', async () => {
    const markCompleted = jest.fn();
    const service = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        insert: jest.fn().mockImplementation(async (record) => ({
          ...record,
          created_at: '2026-07-08T00:00:00.000Z',
          updated_at: '2026-07-08T00:00:00.000Z',
        })),
      }),
      idempotencyService: makeIdempotencyServiceMock({
        markCompleted,
      }),
      providerRegistryService: makeProviderRegistryMock({
        getDefaultProvider: jest.fn().mockReturnValue({
          authorize: jest.fn().mockResolvedValue({
            success: false,
            provider: 'mock',
            failureCode: 'MOCK_AUTHORIZATION_FAILED',
            failureMessage: 'Mock provider authorization failure',
          }),
          capture: jest.fn(),
        }),
      }),
    });

    const result = await service.create({
      correlationId: 'correlation-1',
      idempotencyKey: 'idem-key-1',
      merchantId: 'merchant-1',
      amountMinor: 9999,
      currency: 'TRY',
    });

    expect(result).toMatchObject({
      status: 'FAILED',
      failureCode: 'MOCK_AUTHORIZATION_FAILED',
    });
    expect(markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        responseBody: result,
        responseStatusCode: 201,
      }),
    );
  });

  it('marks idempotency record failed when payment persistence fails', async () => {
    const markFailed = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        insert: jest.fn().mockRejectedValue(new Error('database unavailable')),
      }),
      idempotencyService: makeIdempotencyServiceMock({
        markCompleted: jest.fn(),
        markFailed,
      }),
    });

    await expect(
      service.create({
        correlationId: 'correlation-1',
        idempotencyKey: 'idem-key-1',
        merchantId: 'merchant-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    ).rejects.toThrow('database unavailable');

    expect(markFailed).toHaveBeenCalledWith({ idempotencyRecordId: 'idem-1' });
  });

  it('keeps the original create error when marking idempotency failed also fails', async () => {
    const markFailed = jest.fn().mockRejectedValue(new Error('idempotency unavailable'));
    const logger = makeLoggerMock();
    const service = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        insert: jest.fn().mockRejectedValue(new Error('database unavailable')),
      }),
      idempotencyService: makeIdempotencyServiceMock({
        markFailed,
      }),
      logger,
    });

    await expect(
      service.create({
        correlationId: 'correlation-1',
        idempotencyKey: 'idem-key-1',
        merchantId: 'merchant-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    ).rejects.toThrow('database unavailable');

    expect(markFailed).toHaveBeenCalledWith({ idempotencyRecordId: 'idem-1' });
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to mark idempotency record as failed',
      expect.objectContaining({
        idempotencyRecordId: 'idem-1',
        message: 'idempotency unavailable',
        stack: expect.any(String),
      }),
    );
  });

  it('uses the reactivated idempotency resource id instead of generating a new payment id', async () => {
    const authorize = jest.fn().mockResolvedValue({
      success: true,
      provider: 'mock',
      providerPaymentId: 'provider-payment-1',
    });
    const insert = jest.fn().mockImplementation(async (record) => ({
      ...record,
      created_at: '2026-07-08T00:00:00.000Z',
      updated_at: '2026-07-08T00:00:00.000Z',
    }));
    const service = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        insert,
      }),
      idempotencyService: makeIdempotencyServiceMock({
        getExistingOrStart: jest.fn().mockResolvedValue({
          type: 'STARTED',
          recordId: 'idem-1',
          resourceId: 'reserved-payment-1',
        }),
      }),
      providerRegistryService: makeProviderRegistryMock({
        getDefaultProvider: jest.fn().mockReturnValue({
          authorize,
          capture: jest.fn(),
        }),
      }),
    });

    await service.create({
      correlationId: 'correlation-1',
      idempotencyKey: 'idem-key-1',
      merchantId: 'merchant-1',
      amountMinor: 1000,
      currency: 'TRY',
    });

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 'reserved-payment-1',
    }));
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reserved-payment-1',
      }),
      expect.anything(),
    );
  });
});
