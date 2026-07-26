import type {
  TransactionContext,
  TransactionManagerPort,
} from '../../src/data-access/transaction-manager';
import PaymentsService, {
  IdempotencyServicePort,
  OutboxServicePort,
  PaymentStateServicePort,
  PaymentsDataAccessPort,
  ProviderRegistryServicePort,
} from '../../src/services/payments/payments-service';
import ApiError from '../../src/types/errors/api-error';
import { Logger } from '../../src/utils/logger';

const processingToken = '11111111-1111-4111-8111-111111111111';
const defaultTrx = { trx: true } as unknown as TransactionContext;

type Assert<T extends true> = T;
type OutboxDependencyMustBeRequired = Assert<
  {} extends Pick<ConstructorParameters<typeof PaymentsService>[0], 'outboxService'>
    ? false
    : true
>;

const makePaymentsDataAccessMock = (
  overrides: Partial<jest.Mocked<PaymentsDataAccessPort>> = {},
): jest.Mocked<PaymentsDataAccessPort> => ({
  insert: jest.fn(),
  findById: jest.fn(),
  findByIdForUpdate: jest.fn(),
  updateStatusIfAuthorized: jest.fn(),
  ...overrides,
});

const makeTransactionManagerMock = (
  trx: TransactionContext = defaultTrx,
  overrides: Partial<jest.Mocked<TransactionManagerPort>> = {},
): jest.Mocked<TransactionManagerPort> => ({
  run: jest.fn().mockImplementation(
    async <T>(handler: (transaction: TransactionContext) => Promise<T>) => handler(trx),
  ),
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
    processingToken,
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
  getProvider: jest.fn(),
  ...overrides,
});

const makePaymentStateServiceMock = (
  overrides: Partial<jest.Mocked<PaymentStateServicePort>> = {},
): jest.Mocked<PaymentStateServicePort> => ({
  ensureCanCapture: jest.fn(),
  ensureTransition: jest.fn(),
  ...overrides,
});

const makeOutboxServiceMock = (
  overrides: Partial<jest.Mocked<OutboxServicePort>> = {},
): jest.Mocked<OutboxServicePort> => ({
  recordPaymentAuthorized: jest.fn().mockResolvedValue(undefined),
  recordPaymentCaptured: jest.fn().mockResolvedValue(undefined),
  recordPaymentFailed: jest.fn().mockResolvedValue(undefined),
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
  paymentStateService?: jest.Mocked<PaymentStateServicePort>;
  outboxService?: jest.Mocked<OutboxServicePort>;
  transactionManager?: jest.Mocked<TransactionManagerPort>;
  logger?: jest.Mocked<Logger>;
}) =>
  new PaymentsService({
    paymentsDataAccess: deps?.paymentsDataAccess ?? makePaymentsDataAccessMock(),
    idempotencyService: deps?.idempotencyService ?? makeIdempotencyServiceMock(),
    providerRegistryService: deps?.providerRegistryService ?? makeProviderRegistryMock(),
    paymentStateService: deps?.paymentStateService ?? makePaymentStateServiceMock(),
    outboxService: deps?.outboxService ?? makeOutboxServiceMock(),
    transactionManager: deps?.transactionManager ?? makeTransactionManagerMock(),
    logger: deps?.logger ?? makeLoggerMock(),
  });

const expectCalledBefore = (
  first: { mock: { invocationCallOrder: number[] } },
  second: { mock: { invocationCallOrder: number[] } },
) => {
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
};

const ownershipLostError = () =>
  new ApiError({
    code: 'IDEMPOTENCY_OWNERSHIP_LOST',
    message: 'Idempotency ownership was lost',
    statusCode: 409,
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
    const transactionManager = makeTransactionManagerMock();
    const markCompleted = jest.fn();
    const getDefaultProvider = jest.fn();
    const paymentStateService = makePaymentStateServiceMock();
    const outboxService = makeOutboxServiceMock();
    const service = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        insert,
      }),
      idempotencyService: makeIdempotencyServiceMock({
        getExistingOrStart: jest.fn().mockResolvedValue({
          type: 'COMPLETED',
          responseStatusCode: 202,
          responseBody: cachedPayment,
        }),
        markCompleted,
      }),
      providerRegistryService: makeProviderRegistryMock({
        getDefaultProvider,
      }),
      paymentStateService,
      outboxService,
      transactionManager,
    });

    await expect(
      service.create({
        correlationId: 'correlation-1',
        idempotencyKey: 'idem-key-1',
        merchantId: 'merchant-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    ).resolves.toEqual({
      statusCode: 202,
      body: cachedPayment,
    });

    expect(insert).not.toHaveBeenCalled();
    expect(transactionManager.run).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
    expect(getDefaultProvider).not.toHaveBeenCalled();
    expect(paymentStateService.ensureTransition).not.toHaveBeenCalled();
    expect(outboxService.recordPaymentAuthorized).not.toHaveBeenCalled();
    expect(outboxService.recordPaymentFailed).not.toHaveBeenCalled();
  });

  it('stores successful payment response and authorized outbox event in the same transaction', async () => {
    const trx = { trx: true } as unknown as TransactionContext;
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
      processingToken,
    });
    const paymentStateService = makePaymentStateServiceMock();
    const outboxService = makeOutboxServiceMock();
    const service = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        insert,
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
      paymentStateService,
      outboxService,
      transactionManager: makeTransactionManagerMock(trx),
    });

    const result = await service.create({
      correlationId: 'correlation-1',
      idempotencyKey: 'idem-key-1',
      merchantId: 'merchant-1',
      amountMinor: 1000,
      currency: 'TRY',
    });

    expect(result.statusCode).toBe(201);
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
      processingToken,
      resourceType: 'payment',
      resourceId: result.body.id,
      responseStatusCode: 201,
      responseBody: result.body,
      trx,
    });
    expect(outboxService.recordPaymentAuthorized).toHaveBeenCalledWith(
      {
        correlationId: 'correlation-1',
        payment: expect.objectContaining({
          id: 'payment-1',
          status: 'AUTHORIZED',
        }),
      },
      trx,
    );
    expectCalledBefore(outboxService.recordPaymentAuthorized, markCompleted);
  });

  it('stores authorization failure response and failed outbox event in the same transaction', async () => {
    const trx = { trx: true } as unknown as TransactionContext;
    const markCompleted = jest.fn();
    const insert = jest.fn().mockImplementation(async (record) => ({
      ...record,
      created_at: '2026-07-08T00:00:00.000Z',
      updated_at: '2026-07-08T00:00:00.000Z',
    }));
    const paymentStateService = makePaymentStateServiceMock();
    const outboxService = makeOutboxServiceMock();
    const service = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        insert,
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
      paymentStateService,
      outboxService,
      transactionManager: makeTransactionManagerMock(trx),
    });

    const result = await service.create({
      correlationId: 'correlation-1',
      idempotencyKey: 'idem-key-1',
      merchantId: 'merchant-1',
      amountMinor: 9999,
      currency: 'TRY',
    });

    expect(result).toMatchObject({
      statusCode: 201,
      body: {
        status: 'FAILED',
        failureCode: 'MOCK_AUTHORIZATION_FAILED',
      },
    });
    expect(markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        responseBody: result.body,
        responseStatusCode: 201,
      }),
    );
    expect(outboxService.recordPaymentFailed).toHaveBeenCalledWith(
      {
        correlationId: 'correlation-1',
        operation: 'AUTHORIZE',
        payment: expect.objectContaining({
          id: 'payment-1',
          status: 'FAILED',
          failure_code: 'MOCK_AUTHORIZATION_FAILED',
        }),
      },
      trx,
    );
    expectCalledBefore(outboxService.recordPaymentFailed, markCompleted);
  });

  it.each([
    {
      caseName: 'authorization success',
      amountMinor: 1000,
      authorization: {
        success: true,
        provider: 'mock',
        providerPaymentId: 'provider-payment-1',
      },
      targetStatus: 'AUTHORIZED',
    },
    {
      caseName: 'authorization failure',
      amountMinor: 9999,
      authorization: {
        success: false,
        provider: 'mock',
        failureCode: 'MOCK_AUTHORIZATION_FAILED',
        failureMessage: 'Mock provider authorization failure',
      },
      targetStatus: 'FAILED',
    },
  ])(
    'validates CREATED -> $targetStatus before persistence for $caseName',
    async ({ amountMinor, authorization, targetStatus }) => {
      const insert = jest.fn().mockImplementation(async (record) => ({
        ...record,
        created_at: '2026-07-08T00:00:00.000Z',
        updated_at: '2026-07-08T00:00:00.000Z',
      }));
      const paymentStateService = makePaymentStateServiceMock();
      const service = makeService({
        paymentsDataAccess: makePaymentsDataAccessMock({ insert }),
        providerRegistryService: makeProviderRegistryMock({
          getDefaultProvider: jest.fn().mockReturnValue({
            authorize: jest.fn().mockResolvedValue(authorization),
            capture: jest.fn(),
          }),
        }),
        paymentStateService,
      });

      await service.create({
        correlationId: 'correlation-1',
        idempotencyKey: 'idem-key-1',
        merchantId: 'merchant-1',
        amountMinor,
        currency: 'TRY',
      });

      expect(paymentStateService.ensureTransition).toHaveBeenCalledWith(
        'CREATED',
        targetStatus,
      );
      expectCalledBefore(paymentStateService.ensureTransition, insert);
    },
  );

  it.each([
    {
      caseName: 'authorization success',
      amountMinor: 1000,
      authorization: {
        success: true,
        provider: 'mock',
        providerPaymentId: 'provider-payment-1',
      },
      failingMethod: 'recordPaymentAuthorized' as const,
    },
    {
      caseName: 'authorization failure',
      amountMinor: 9999,
      authorization: {
        success: false,
        provider: 'mock',
        failureCode: 'MOCK_AUTHORIZATION_FAILED',
        failureMessage: 'Mock provider authorization failure',
      },
      failingMethod: 'recordPaymentFailed' as const,
    },
  ])(
    'preserves the outbox error and marks idempotency failed for $caseName',
    async ({ amountMinor, authorization, failingMethod }) => {
      const outboxError = new Error('outbox unavailable');
      const outboxService = makeOutboxServiceMock();
      outboxService[failingMethod].mockRejectedValue(outboxError);
      const markCompleted = jest.fn();
      const markFailed = jest.fn().mockResolvedValue(undefined);
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
          markFailed,
        }),
        providerRegistryService: makeProviderRegistryMock({
          getDefaultProvider: jest.fn().mockReturnValue({
            authorize: jest.fn().mockResolvedValue(authorization),
            capture: jest.fn(),
          }),
        }),
        outboxService,
      });

      await expect(
        service.create({
          correlationId: 'correlation-1',
          idempotencyKey: 'idem-key-1',
          merchantId: 'merchant-1',
          amountMinor,
          currency: 'TRY',
        }),
      ).rejects.toBe(outboxError);

      expect(outboxService[failingMethod]).toHaveBeenCalledTimes(1);
      expect(markCompleted).not.toHaveBeenCalled();
      expect(markFailed).toHaveBeenCalledWith({
        idempotencyRecordId: 'idem-1',
        processingToken,
      });
    },
  );

  it('rejects stale completion so the create transaction cannot commit payment and outbox state', async () => {
    const trx = { trx: true } as unknown as TransactionContext;
    let committed = false;
    let rolledBack = false;
    const transactionManager = makeTransactionManagerMock(trx, {
      run: jest.fn().mockImplementation(async (handler) => {
        try {
          const result = await handler(trx);
          committed = true;
          return result;
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      }),
    });
    const markCompleted = jest.fn().mockRejectedValue(ownershipLostError());
    const markFailed = jest.fn().mockRejectedValue(ownershipLostError());
    const outboxService = makeOutboxServiceMock();
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
        markFailed,
      }),
      outboxService,
      transactionManager,
    });

    await expect(
      service.create({
        correlationId: 'correlation-1',
        idempotencyKey: 'idem-key-1',
        merchantId: 'merchant-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_OWNERSHIP_LOST',
      statusCode: 409,
    });

    expect(outboxService.recordPaymentAuthorized).toHaveBeenCalledWith(
      {
        correlationId: 'correlation-1',
        payment: expect.objectContaining({ id: 'payment-1', status: 'AUTHORIZED' }),
      },
      trx,
    );
    expect(markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ processingToken, trx }),
    );
    expect(markFailed).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      processingToken,
    });
    expect(transactionManager.run).toHaveBeenCalledTimes(1);
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
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

    expect(markFailed).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      processingToken,
    });
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

    expect(markFailed).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      processingToken,
    });
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
          processingToken,
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
