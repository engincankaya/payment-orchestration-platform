import type { PaymentRecord } from '../../src/data-access/payments/payments-data-access';
import type { TransactionContext } from '../../src/data-access/transaction-manager';

type OutboxServiceConstructor =
  typeof import('../../src/services/outbox/outbox-service').default;
type OutboxServiceInstance = InstanceType<OutboxServiceConstructor>;

const outboxServiceModulePath = '../../src/services/outbox/outbox-service';
const trx = { id: 'outbox-trx' } as unknown as TransactionContext;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const authorizedPayment: PaymentRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  merchant_id: '22222222-2222-4222-8222-222222222222',
  amount_minor: '1000',
  currency: 'TRY',
  status: 'AUTHORIZED',
  provider: 'mock-provider',
  provider_payment_id: 'provider-payment-1',
  failure_code: null,
  failure_message: null,
  authorized_at: new Date('2026-07-23T10:00:00.000Z'),
  captured_at: null,
  failed_at: null,
  created_at: new Date('2026-07-23T09:00:00.000Z'),
  updated_at: new Date('2026-07-23T10:00:00.000Z'),
};

const capturedPayment: PaymentRecord = {
  ...authorizedPayment,
  status: 'CAPTURED',
  captured_at: new Date('2026-07-23T11:00:00.000Z'),
  updated_at: new Date('2026-07-23T11:00:00.000Z'),
};

const authorizeFailedPayment: PaymentRecord = {
  ...authorizedPayment,
  amount_minor: '9999',
  status: 'FAILED',
  provider_payment_id: null,
  authorized_at: null,
  failed_at: new Date('2026-07-23T10:00:00.000Z'),
  failure_code: 'MOCK_AUTHORIZATION_FAILED',
  failure_message: 'Mock authorization failure',
};

const captureFailedPayment: PaymentRecord = {
  ...authorizedPayment,
  status: 'CAPTURE_FAILED',
  captured_at: null,
  failed_at: new Date('2026-07-23T11:00:00.000Z'),
  failure_code: 'MOCK_CAPTURE_FAILED',
  failure_message: 'Mock capture failure',
};

function makeService(
  insertPending = jest.fn().mockImplementation(async (record) => record),
) {
  const { default: OutboxService } = require(outboxServiceModulePath) as {
    default: OutboxServiceConstructor;
  };

  return {
    insertPending,
    service: new OutboxService({
      outboxEventsDataAccess: { insertPending },
    }),
  };
}

function expectSingleInsertInTransaction(insertPending: jest.Mock) {
  expect(insertPending).toHaveBeenCalledTimes(1);
  expect(insertPending).toHaveBeenCalledWith(expect.any(Object), trx);
}

function expectCommonEnvelope(
  record: Record<string, any>,
  eventType: string,
  correlationId: string,
  paymentId: string,
) {
  expect(record).toEqual(
    expect.objectContaining({
      id: expect.stringMatching(uuidPattern),
      aggregateType: 'payment',
      aggregateId: paymentId,
      eventType,
      eventVersion: 1,
      routingKey: eventType,
      payload: expect.objectContaining({
        eventId: expect.stringMatching(uuidPattern),
        eventType,
        eventVersion: 1,
        source: 'payment-service',
        correlationId,
        occurredAt: expect.any(String),
        aggregateType: 'payment',
        aggregateId: paymentId,
        payload: expect.objectContaining({
          paymentId,
        }),
      }),
    }),
  );
  expect(record.id).toBe(record.payload.eventId);
  expect(record.aggregateId).toBe(record.payload.aggregateId);
  expect(record.payload.aggregateId).toBe(record.payload.payload.paymentId);
  expect(new Date(record.payload.occurredAt).toISOString()).toBe(record.payload.occurredAt);
}

describe('OutboxService', () => {
  it('records a payment.authorized.v1 envelope with its routing key', async () => {
    const { insertPending, service } = makeService();

    await service.recordPaymentAuthorized({
      correlationId: 'trace-authorize-1',
      payment: authorizedPayment,
    }, trx);

    expectSingleInsertInTransaction(insertPending);
    const record = insertPending.mock.calls[0][0];
    expectCommonEnvelope(
      record,
      'payment.authorized.v1',
      'trace-authorize-1',
      authorizedPayment.id,
    );
    expect(record.payload.payload).toEqual({
      paymentId: authorizedPayment.id,
      merchantId: authorizedPayment.merchant_id,
      amountMinor: 1000,
      currency: authorizedPayment.currency,
      provider: authorizedPayment.provider,
      providerPaymentId: authorizedPayment.provider_payment_id,
      authorizedAt: '2026-07-23T10:00:00.000Z',
    });
  });

  it('records a payment.captured.v1 envelope with its routing key', async () => {
    const { insertPending, service } = makeService();

    await service.recordPaymentCaptured({
      correlationId: 'trace-capture-1',
      payment: capturedPayment,
    }, trx);

    expectSingleInsertInTransaction(insertPending);
    const record = insertPending.mock.calls[0][0];
    expectCommonEnvelope(
      record,
      'payment.captured.v1',
      'trace-capture-1',
      capturedPayment.id,
    );
    expect(record.payload.payload).toEqual({
      paymentId: capturedPayment.id,
      merchantId: capturedPayment.merchant_id,
      amountMinor: 1000,
      currency: capturedPayment.currency,
      provider: capturedPayment.provider,
      providerPaymentId: capturedPayment.provider_payment_id,
      capturedAt: '2026-07-23T11:00:00.000Z',
    });
  });

  it.each([
    {
      operation: 'AUTHORIZE',
      expectedStatus: 'FAILED',
      payment: authorizeFailedPayment,
    },
    {
      operation: 'CAPTURE',
      expectedStatus: 'CAPTURE_FAILED',
      payment: captureFailedPayment,
    },
  ] as const)(
    'records a payment.failed.v1 envelope for $operation failure',
    async ({ operation, expectedStatus, payment }) => {
      const { insertPending, service } = makeService();

      await service.recordPaymentFailed({
        correlationId: `trace-${operation.toLowerCase()}-failure`,
        operation,
        payment,
      }, trx);

      expectSingleInsertInTransaction(insertPending);
      const record = insertPending.mock.calls[0][0];
      expectCommonEnvelope(
        record,
        'payment.failed.v1',
        `trace-${operation.toLowerCase()}-failure`,
        payment.id,
      );
      expect(record.payload.payload).toEqual({
        paymentId: payment.id,
        merchantId: payment.merchant_id,
        amountMinor: operation === 'AUTHORIZE' ? 9999 : 1000,
        currency: payment.currency,
        provider: payment.provider,
        providerPaymentId: payment.provider_payment_id,
        operation,
        status: expectedStatus,
        failureCode: payment.failure_code,
        failureMessage: payment.failure_message,
        failedAt:
          operation === 'AUTHORIZE'
            ? '2026-07-23T10:00:00.000Z'
            : '2026-07-23T11:00:00.000Z',
      });
    },
  );

  it('creates a distinct event identity for each recorded event', async () => {
    const { insertPending, service } = makeService();

    await service.recordPaymentAuthorized({
      correlationId: 'trace-authorize-1',
      payment: authorizedPayment,
    }, trx);
    await service.recordPaymentAuthorized({
      correlationId: 'trace-authorize-2',
      payment: authorizedPayment,
    }, trx);

    expect(insertPending).toHaveBeenCalledTimes(2);
    const firstRecord = insertPending.mock.calls[0][0];
    const secondRecord = insertPending.mock.calls[1][0];
    expect(firstRecord.id).not.toBe(secondRecord.id);
    expect(firstRecord.payload.eventId).not.toBe(secondRecord.payload.eventId);
  });

  it.each([
    {
      caseName: 'authorized',
      expectedField: 'providerPaymentId',
      invoke: (service: OutboxServiceInstance) =>
        service.recordPaymentAuthorized({
          correlationId: 'trace-authorize-1',
          payment: {
            ...authorizedPayment,
            provider_payment_id: null,
          },
        }, trx),
    },
    {
      caseName: 'captured',
      expectedField: 'providerPaymentId',
      invoke: (service: OutboxServiceInstance) =>
        service.recordPaymentCaptured({
          correlationId: 'trace-capture-1',
          payment: {
            ...capturedPayment,
            provider_payment_id: '',
          },
        }, trx),
    },
  ])(
    'rejects a $caseName event without $expectedField',
    async ({ expectedField, invoke }) => {
      const { insertPending, service } = makeService();

      await expect(invoke(service)).rejects.toThrow(expectedField);

      expect(insertPending).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      operation: 'AUTHORIZE' as const,
      missingField: 'failureCode',
      payment: {
        ...authorizeFailedPayment,
        failure_code: null,
      },
    },
    {
      operation: 'AUTHORIZE' as const,
      missingField: 'failureMessage',
      payment: {
        ...authorizeFailedPayment,
        failure_message: null,
      },
    },
    {
      operation: 'CAPTURE' as const,
      missingField: 'failureCode',
      payment: {
        ...captureFailedPayment,
        failure_code: '',
      },
    },
    {
      operation: 'CAPTURE' as const,
      missingField: 'failureMessage',
      payment: {
        ...captureFailedPayment,
        failure_message: '',
      },
    },
  ])(
    'rejects a $operation failure event without $missingField',
    async ({ missingField, operation, payment }) => {
      const { insertPending, service } = makeService();

      await expect(service.recordPaymentFailed({
        correlationId: `trace-${operation.toLowerCase()}-failure`,
        operation,
        payment,
      }, trx)).rejects.toThrow(missingField);

      expect(insertPending).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      caseName: 'authorized',
      invoke: (service: OutboxServiceInstance) =>
        service.recordPaymentAuthorized({
          correlationId: 'trace-authorize-1',
          payment: authorizedPayment,
        }, trx),
    },
    {
      caseName: 'captured',
      invoke: (service: OutboxServiceInstance) =>
        service.recordPaymentCaptured({
          correlationId: 'trace-capture-1',
          payment: capturedPayment,
        }, trx),
    },
    {
      caseName: 'authorize failed',
      invoke: (service: OutboxServiceInstance) =>
        service.recordPaymentFailed({
          correlationId: 'trace-authorize-failure',
          operation: 'AUTHORIZE',
          payment: authorizeFailedPayment,
        }, trx),
    },
    {
      caseName: 'capture failed',
      invoke: (service: OutboxServiceInstance) =>
        service.recordPaymentFailed({
          correlationId: 'trace-capture-failure',
          operation: 'CAPTURE',
          payment: captureFailedPayment,
        }, trx),
    },
  ])('propagates insertPending errors for $caseName events', async ({ invoke }) => {
    const persistenceError = new Error('outbox insert failed');
    const insertPending = jest.fn().mockRejectedValue(persistenceError);
    const { service } = makeService(insertPending);

    await expect(invoke(service)).rejects.toBe(persistenceError);

    expectSingleInsertInTransaction(insertPending);
  });
});
