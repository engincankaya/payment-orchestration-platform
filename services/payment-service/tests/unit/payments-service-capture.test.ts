import type { PaymentRecord } from '../../src/data-access/payments/payments-data-access';
import PaymentsService from '../../src/services/payments/payments-service';
import type {
  IdempotencyServicePort,
  OutboxServicePort,
  PaymentsDataAccessPort,
  PaymentStateServicePort,
  ProviderRegistryServicePort,
} from '../../src/services/payments/payments-service';
import ApiError from '../../src/types/errors/api-error';
import type { Logger } from '../../src/utils/logger';

const trx = { id: 'capture-trx' };
const processingToken = '11111111-1111-4111-8111-111111111111';

const authorizedPayment: PaymentRecord = {
  id: 'payment-1',
  merchant_id: 'merchant-1',
  amount_minor: 1000,
  currency: 'TRY',
  status: 'AUTHORIZED',
  provider: 'original-provider',
  provider_payment_id: 'provider-payment-1',
  failure_code: null,
  failure_message: null,
  authorized_at: '2026-07-23T10:00:00.000Z',
  captured_at: null,
  failed_at: null,
  created_at: '2026-07-23T09:00:00.000Z',
  updated_at: '2026-07-23T10:00:00.000Z',
};

const capturedPayment: PaymentRecord = {
  ...authorizedPayment,
  status: 'CAPTURED',
  captured_at: '2026-07-23T11:00:00.000Z',
  updated_at: '2026-07-23T11:00:00.000Z',
};

const captureFailedPayment: PaymentRecord = {
  ...authorizedPayment,
  status: 'CAPTURE_FAILED',
  captured_at: null,
  failed_at: '2026-07-23T11:00:00.000Z',
  failure_code: 'MOCK_CAPTURE_FAILED',
  failure_message: 'Mock provider capture failure',
  updated_at: '2026-07-23T11:00:00.000Z',
};

const captureCommand = {
  correlationId: 'trace-capture-1',
  idempotencyKey: 'capture-key-1',
  paymentId: 'payment-1',
};

const provider = {
  authorize: jest.fn(),
  capture: jest.fn().mockResolvedValue({
    success: true,
    provider: 'original-provider',
  }),
};

const makePaymentsDataAccessMock = (
  overrides: Partial<jest.Mocked<PaymentsDataAccessPort>> = {},
): jest.Mocked<PaymentsDataAccessPort> => ({
  insert: jest.fn(),
  findById: jest.fn(),
  findByIdForUpdate: jest.fn().mockResolvedValue(authorizedPayment),
  updateStatusIfAuthorized: jest.fn().mockResolvedValue(capturedPayment),
  withTransaction: jest.fn().mockImplementation((handler) => handler(trx)),
  ...overrides,
});

const makeIdempotencyServiceMock = (
  overrides: Partial<jest.Mocked<IdempotencyServicePort>> = {},
): jest.Mocked<IdempotencyServicePort> => ({
  buildRequestHash: jest.fn().mockReturnValue('capture-hash-1'),
  getExistingOrStart: jest.fn().mockResolvedValue({
    type: 'STARTED',
    recordId: 'idem-1',
    resourceId: 'payment-1',
    processingToken,
  }),
  markCompleted: jest.fn().mockResolvedValue({ id: 'idem-1', status: 'COMPLETED' }),
  markFailed: jest.fn().mockResolvedValue({ id: 'idem-1', status: 'FAILED' }),
  ...overrides,
});

const makeProviderRegistryMock = (
  overrides: Partial<jest.Mocked<ProviderRegistryServicePort>> = {},
): jest.Mocked<ProviderRegistryServicePort> => ({
  getDefaultProvider: jest.fn(),
  getProvider: jest.fn().mockReturnValue(provider),
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
  recordPaymentCaptured: jest.fn().mockResolvedValue(undefined),
  recordPaymentFailed: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const makeLoggerMock = (): jest.Mocked<Logger> => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const makeService = (deps: {
  paymentsDataAccess?: jest.Mocked<PaymentsDataAccessPort>;
  idempotencyService?: jest.Mocked<IdempotencyServicePort>;
  providerRegistryService?: jest.Mocked<ProviderRegistryServicePort>;
  paymentStateService?: jest.Mocked<PaymentStateServicePort>;
  outboxService?: jest.Mocked<OutboxServicePort>;
  logger?: jest.Mocked<Logger>;
} = {}) => {
  const resolved = {
    paymentsDataAccess: deps.paymentsDataAccess ?? makePaymentsDataAccessMock(),
    idempotencyService: deps.idempotencyService ?? makeIdempotencyServiceMock(),
    providerRegistryService: deps.providerRegistryService ?? makeProviderRegistryMock(),
    paymentStateService: deps.paymentStateService ?? makePaymentStateServiceMock(),
    outboxService: deps.outboxService ?? makeOutboxServiceMock(),
    logger: deps.logger ?? makeLoggerMock(),
  };

  return {
    ...resolved,
    service: new PaymentsService(resolved),
  };
};

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

describe('PaymentsService.capture', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    provider.capture.mockResolvedValue({
      success: true,
      provider: 'original-provider',
    });
  });

  it('returns a completed idempotency response before payment lookup or transaction work', async () => {
    const cachedBody = { id: 'payment-1', status: 'CAPTURED' };
    const paymentsDataAccess = makePaymentsDataAccessMock();
    const providerRegistryService = makeProviderRegistryMock();
    const outboxService = makeOutboxServiceMock();
    const { service } = makeService({
      paymentsDataAccess,
      idempotencyService: makeIdempotencyServiceMock({
        getExistingOrStart: jest.fn().mockResolvedValue({
          type: 'COMPLETED',
          responseStatusCode: 200,
          responseBody: cachedBody,
        }),
      }),
      providerRegistryService,
      outboxService,
    });

    await expect(service.capture(captureCommand)).resolves.toEqual({
      statusCode: 200,
      body: cachedBody,
    });

    expect(paymentsDataAccess.findByIdForUpdate).not.toHaveBeenCalled();
    expect(paymentsDataAccess.withTransaction).not.toHaveBeenCalled();
    expect(providerRegistryService.getProvider).not.toHaveBeenCalled();
    expect(outboxService.recordPaymentCaptured).not.toHaveBeenCalled();
    expect(outboxService.recordPaymentFailed).not.toHaveBeenCalled();
  });

  it('uses payment-scoped idempotency and hashes the payment id instead of the empty HTTP body', async () => {
    const idempotencyService = makeIdempotencyServiceMock();
    const { service } = makeService({ idempotencyService });

    await service.capture(captureCommand);

    expect(idempotencyService.buildRequestHash).toHaveBeenCalledWith({
      paymentId: 'payment-1',
    });
    expect(idempotencyService.getExistingOrStart).toHaveBeenCalledWith({
      scope: 'payments:capture:payment-1',
      idempotencyKey: 'capture-key-1',
      requestHash: 'capture-hash-1',
      resource: {
        type: 'payment',
        id: 'payment-1',
      },
    });
  });

  it('propagates the STARTED ownership token to successful completion', async () => {
    const idempotencyService = makeIdempotencyServiceMock();
    const { service } = makeService({ idempotencyService });

    await service.capture(captureCommand);

    expect(idempotencyService.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyRecordId: 'idem-1',
        processingToken,
        responseStatusCode: 200,
        trx,
      }),
    );
  });

  it('marks owned idempotency state FAILED and returns 404 when the payment does not exist', async () => {
    const idempotencyService = makeIdempotencyServiceMock();
    const providerRegistryService = makeProviderRegistryMock();
    const { service } = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        findByIdForUpdate: jest.fn().mockResolvedValue(null),
      }),
      idempotencyService,
      providerRegistryService,
    });

    await expect(service.capture(captureCommand)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_FOUND',
      statusCode: 404,
    });

    expect(idempotencyService.markFailed).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      processingToken,
    });
    expect(providerRegistryService.getProvider).not.toHaveBeenCalled();
  });

  it('preserves PAYMENT_NOT_CAPTURABLE and marks owned idempotency state FAILED', async () => {
    const notCapturable = new ApiError({
      code: 'PAYMENT_NOT_CAPTURABLE',
      message: 'Payment is not capturable',
      statusCode: 409,
    });
    const idempotencyService = makeIdempotencyServiceMock();
    const providerRegistryService = makeProviderRegistryMock();
    const paymentStateService = makePaymentStateServiceMock({
      ensureCanCapture: jest.fn().mockImplementation(() => {
        throw notCapturable;
      }),
    });
    const { service } = makeService({
      idempotencyService,
      providerRegistryService,
      paymentStateService,
    });

    await expect(service.capture(captureCommand)).rejects.toBe(notCapturable);

    expect(idempotencyService.markFailed).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      processingToken,
    });
    expect(providerRegistryService.getProvider).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'PAYMENT_NOT_FOUND',
      paymentsDataAccess: () =>
        makePaymentsDataAccessMock({
          findByIdForUpdate: jest.fn().mockResolvedValue(null),
        }),
      paymentStateService: () => makePaymentStateServiceMock(),
      expectedCode: 'PAYMENT_NOT_FOUND',
      expectedStatus: 404,
    },
    {
      name: 'PAYMENT_NOT_CAPTURABLE',
      paymentsDataAccess: () => makePaymentsDataAccessMock(),
      paymentStateService: () =>
        makePaymentStateServiceMock({
          ensureCanCapture: jest.fn().mockImplementation(() => {
            throw new ApiError({
              code: 'PAYMENT_NOT_CAPTURABLE',
              message: 'Payment is not capturable',
              statusCode: 409,
            });
          }),
        }),
      expectedCode: 'PAYMENT_NOT_CAPTURABLE',
      expectedStatus: 409,
    },
  ])(
    'keeps $name when the secondary markFailed persistence write fails',
    async ({ expectedCode, expectedStatus, paymentStateService, paymentsDataAccess }) => {
      const secondaryError = new Error('idempotency database unavailable');
      const logger = makeLoggerMock();
      const { service } = makeService({
        paymentsDataAccess: paymentsDataAccess(),
        idempotencyService: makeIdempotencyServiceMock({
          markFailed: jest.fn().mockRejectedValue(secondaryError),
        }),
        paymentStateService: paymentStateService(),
        logger,
      });

      await expect(service.capture(captureCommand)).rejects.toMatchObject({
        code: expectedCode,
        statusCode: expectedStatus,
      });

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to mark idempotency record as failed',
        expect.objectContaining({
          idempotencyRecordId: 'idem-1',
          message: 'idempotency database unavailable',
          stack: expect.any(String),
        }),
      );
    },
  );

  it('resolves the provider recorded on the payment instead of the current default provider', async () => {
    const providerRegistryService = makeProviderRegistryMock();
    const { service } = makeService({ providerRegistryService });

    await service.capture(captureCommand);

    expect(providerRegistryService.getProvider).toHaveBeenCalledWith('original-provider');
    expect(providerRegistryService.getDefaultProvider).not.toHaveBeenCalled();
  });

  it('fails closed when the recorded provider is not configured', async () => {
    const providerNotConfigured = new ApiError({
      code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
      message: 'Payment provider is not configured',
      statusCode: 500,
      isOperational: false,
    });
    const idempotencyService = makeIdempotencyServiceMock();
    const providerRegistryService = makeProviderRegistryMock({
      getProvider: jest.fn().mockImplementation(() => {
        throw providerNotConfigured;
      }),
    });
    const { service } = makeService({
      idempotencyService,
      providerRegistryService,
    });

    await expect(service.capture(captureCommand)).rejects.toBe(providerNotConfigured);

    expect(provider.capture).not.toHaveBeenCalled();
    expect(idempotencyService.markFailed).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      processingToken,
    });
  });

  it('fails closed before provider capture when the provider payment reference is missing', async () => {
    const idempotencyService = makeIdempotencyServiceMock();
    const { service } = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        findByIdForUpdate: jest.fn().mockResolvedValue({
          ...authorizedPayment,
          provider_payment_id: null,
        }),
      }),
      idempotencyService,
    });

    await expect(service.capture(captureCommand)).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_REFERENCE_MISSING',
      statusCode: 500,
      isOperational: false,
    });

    expect(provider.capture).not.toHaveBeenCalled();
    expect(idempotencyService.markFailed).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      processingToken,
    });
  });

  it('captures the recorded full amount and currency with the stable provider references', async () => {
    const { service } = makeService();

    await service.capture(captureCommand);

    expect(provider.capture).toHaveBeenCalledWith({
      paymentId: 'payment-1',
      providerPaymentId: 'provider-payment-1',
      amountMinor: 1000,
      currency: 'TRY',
    });
  });

  it('takes the row lock and validates capturability before the provider side effect', async () => {
    const paymentsDataAccess = makePaymentsDataAccessMock();
    const paymentStateService = makePaymentStateServiceMock();
    const idempotencyService = makeIdempotencyServiceMock();
    const outboxService = makeOutboxServiceMock();
    const { service } = makeService({
      paymentsDataAccess,
      paymentStateService,
      idempotencyService,
      outboxService,
    });

    await service.capture(captureCommand);

    expect(paymentsDataAccess.findByIdForUpdate).toHaveBeenCalledWith('payment-1', trx);
    expect(paymentStateService.ensureCanCapture).toHaveBeenCalledWith(authorizedPayment);
    expectCalledBefore(paymentsDataAccess.findByIdForUpdate, provider.capture);
    expectCalledBefore(paymentStateService.ensureCanCapture, provider.capture);
    expectCalledBefore(provider.capture, paymentStateService.ensureTransition);
    expectCalledBefore(
      paymentStateService.ensureTransition,
      paymentsDataAccess.updateStatusIfAuthorized,
    );
    expectCalledBefore(provider.capture, paymentsDataAccess.updateStatusIfAuthorized);
    expectCalledBefore(provider.capture, outboxService.recordPaymentCaptured);
    expectCalledBefore(provider.capture, idempotencyService.markCompleted);
  });

  it('records CAPTURED, outbox, and COMPLETED in the same transaction on provider success', async () => {
    const paymentsDataAccess = makePaymentsDataAccessMock();
    const paymentStateService = makePaymentStateServiceMock();
    const outboxService = makeOutboxServiceMock();
    const idempotencyService = makeIdempotencyServiceMock();
    const { service } = makeService({
      paymentsDataAccess,
      paymentStateService,
      outboxService,
      idempotencyService,
    });

    const result = await service.capture(captureCommand);

    expect(paymentStateService.ensureTransition).toHaveBeenCalledWith('AUTHORIZED', 'CAPTURED');
    expect(paymentsDataAccess.updateStatusIfAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'payment-1',
        status: 'CAPTURED',
        captured_at: expect.any(Date),
        failed_at: null,
        failure_code: null,
        failure_message: null,
      }),
      trx,
    );
    expect(outboxService.recordPaymentCaptured).toHaveBeenCalledWith(
      {
        correlationId: 'trace-capture-1',
        payment: capturedPayment,
      },
      trx,
    );
    expect(idempotencyService.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyRecordId: 'idem-1',
        processingToken,
        responseStatusCode: 200,
        responseBody: expect.objectContaining({ status: 'CAPTURED' }),
        trx,
      }),
    );
    expect(result).toMatchObject({
      statusCode: 200,
      body: { status: 'CAPTURED' },
    });
  });

  it('records CAPTURE_FAILED as a completed business result without markFailed', async () => {
    provider.capture.mockResolvedValue({
      success: false,
      provider: 'original-provider',
      failureCode: 'MOCK_CAPTURE_FAILED',
      failureMessage: 'Mock provider capture failure',
    });
    const paymentsDataAccess = makePaymentsDataAccessMock({
      updateStatusIfAuthorized: jest.fn().mockResolvedValue(captureFailedPayment),
    });
    const paymentStateService = makePaymentStateServiceMock();
    const outboxService = makeOutboxServiceMock();
    const idempotencyService = makeIdempotencyServiceMock();
    const { service } = makeService({
      paymentsDataAccess,
      paymentStateService,
      outboxService,
      idempotencyService,
    });

    const result = await service.capture(captureCommand);

    expect(paymentStateService.ensureTransition).toHaveBeenCalledWith(
      'AUTHORIZED',
      'CAPTURE_FAILED',
    );
    expect(paymentsDataAccess.updateStatusIfAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'payment-1',
        status: 'CAPTURE_FAILED',
        captured_at: null,
        failed_at: expect.any(Date),
        failure_code: 'MOCK_CAPTURE_FAILED',
        failure_message: 'Mock provider capture failure',
      }),
      trx,
    );
    expect(outboxService.recordPaymentFailed).toHaveBeenCalledWith(
      {
        correlationId: 'trace-capture-1',
        operation: 'CAPTURE',
        payment: captureFailedPayment,
      },
      trx,
    );
    expect(idempotencyService.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        processingToken,
        responseStatusCode: 200,
        responseBody: expect.objectContaining({ status: 'CAPTURE_FAILED' }),
        trx,
      }),
    );
    expect(idempotencyService.markFailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        status: 'CAPTURE_FAILED',
        failureCode: 'MOCK_CAPTURE_FAILED',
      },
    });
  });

  it('does not mutate durable payment/outbox state when provider capture throws', async () => {
    const providerError = new Error('provider unavailable');
    provider.capture.mockRejectedValue(providerError);
    const paymentsDataAccess = makePaymentsDataAccessMock();
    const outboxService = makeOutboxServiceMock();
    const idempotencyService = makeIdempotencyServiceMock();
    const { service } = makeService({
      paymentsDataAccess,
      outboxService,
      idempotencyService,
    });

    await expect(service.capture(captureCommand)).rejects.toBe(providerError);

    expect(paymentsDataAccess.updateStatusIfAuthorized).not.toHaveBeenCalled();
    expect(outboxService.recordPaymentCaptured).not.toHaveBeenCalled();
    expect(outboxService.recordPaymentFailed).not.toHaveBeenCalled();
    expect(idempotencyService.markCompleted).not.toHaveBeenCalled();
    expect(idempotencyService.markFailed).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      processingToken,
    });
  });

  it('turns a zero-row conditional payment update into PAYMENT_NOT_CAPTURABLE', async () => {
    const idempotencyService = makeIdempotencyServiceMock();
    const outboxService = makeOutboxServiceMock();
    const { service } = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        updateStatusIfAuthorized: jest.fn().mockResolvedValue(null),
      }),
      idempotencyService,
      outboxService,
    });

    await expect(service.capture(captureCommand)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_CAPTURABLE',
      statusCode: 409,
    });

    expect(outboxService.recordPaymentCaptured).not.toHaveBeenCalled();
    expect(idempotencyService.markCompleted).not.toHaveBeenCalled();
    expect(idempotencyService.markFailed).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      processingToken,
    });
  });

  it('preserves an unexpected update error when markFailed also fails and logs the secondary error', async () => {
    const updateError = new Error('payment update unavailable');
    const logger = makeLoggerMock();
    const idempotencyService = makeIdempotencyServiceMock({
      markFailed: jest.fn().mockRejectedValue(new Error('idempotency unavailable')),
    });
    const { service } = makeService({
      paymentsDataAccess: makePaymentsDataAccessMock({
        updateStatusIfAuthorized: jest.fn().mockRejectedValue(updateError),
      }),
      idempotencyService,
      logger,
    });

    await expect(service.capture(captureCommand)).rejects.toBe(updateError);

    expect(idempotencyService.markFailed).toHaveBeenCalledWith({
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

  it.each([
    {
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
      message: 'Idempotency key mismatch',
    },
    {
      code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      message: 'Idempotency request is already processing',
    },
  ])(
    'does not mark FAILED for $code before this request owns a record',
    async ({ code, message }) => {
      const ownershipRejection = new ApiError({
        code,
        message,
        statusCode: 409,
      });
      const idempotencyService = makeIdempotencyServiceMock({
        getExistingOrStart: jest.fn().mockRejectedValue(ownershipRejection),
      });
      const paymentsDataAccess = makePaymentsDataAccessMock();
      const { service } = makeService({
        idempotencyService,
        paymentsDataAccess,
      });

      await expect(service.capture(captureCommand)).rejects.toBe(ownershipRejection);

      expect(idempotencyService.markFailed).not.toHaveBeenCalled();
      expect(paymentsDataAccess.withTransaction).not.toHaveBeenCalled();
    },
  );

  it('rejects stale completion and does not convert ownership loss into a success response', async () => {
    const idempotencyService = makeIdempotencyServiceMock({
      markCompleted: jest.fn().mockRejectedValue(ownershipLostError()),
      markFailed: jest.fn().mockRejectedValue(ownershipLostError()),
    });
    const paymentsDataAccess = makePaymentsDataAccessMock();
    const outboxService = makeOutboxServiceMock();
    const { service } = makeService({
      idempotencyService,
      paymentsDataAccess,
      outboxService,
    });

    await expect(service.capture(captureCommand)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_OWNERSHIP_LOST',
      statusCode: 409,
    });

    expect(paymentsDataAccess.updateStatusIfAuthorized).toHaveBeenCalled();
    expect(outboxService.recordPaymentCaptured).toHaveBeenCalled();
    expect(idempotencyService.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ processingToken, trx }),
    );
    expect(idempotencyService.markFailed).toHaveBeenCalledWith({
      idempotencyRecordId: 'idem-1',
      processingToken,
    });
    expect(paymentsDataAccess.withTransaction).toHaveBeenCalledTimes(1);
  });
});
