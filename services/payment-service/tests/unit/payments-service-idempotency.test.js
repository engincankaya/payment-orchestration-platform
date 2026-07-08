const assert = require('node:assert/strict');
const test = require('node:test');

const PaymentsService = require('../../dist/services/payments/payments-service').default;

test('create returns cached payment response and skips provider and payment insert for repeated idempotency request', async () => {
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

  const service = new PaymentsService({
    paymentsDataAccess: {
      insert: async () => {
        throw new Error('payment insert should not be called for cached response');
      },
      findById: async () => null,
      withTransaction: async () => {
        throw new Error('transaction should not start for cached response');
      },
    },
    idempotencyService: {
      buildRequestHash: () => 'hash-1',
      getExistingOrStart: async () => ({
        type: 'COMPLETED',
        responseStatusCode: 201,
        responseBody: cachedPayment,
      }),
      markCompleted: async () => {
        throw new Error('markCompleted should not be called for cached response');
      },
    },
    providerRegistryService: {
      getDefaultProvider: () => {
        throw new Error('provider should not be called for cached response');
      },
    },
  });

  const result = await service.create({
    correlationId: 'correlation-1',
    idempotencyKey: 'idem-key-1',
    merchantId: 'merchant-1',
    amountMinor: 1000,
    currency: 'TRY',
  });

  assert.deepEqual(result, cachedPayment);
});

test('create stores successful payment response in idempotency record', async () => {
  const completedCalls = [];
  const insertedPayments = [];

  const service = new PaymentsService({
    paymentsDataAccess: {
      insert: async (record) => {
        insertedPayments.push(record);
        return {
          ...record,
          created_at: '2026-07-08T00:00:00.000Z',
          updated_at: '2026-07-08T00:00:00.000Z',
        };
      },
      findById: async () => null,
      withTransaction: async (handler) => handler({ trx: true }),
    },
    idempotencyService: {
      buildRequestHash: () => 'hash-1',
      getExistingOrStart: async (input) => {
        assert.equal(input.scope, 'payments:create:merchant-1');
        assert.equal(input.idempotencyKey, 'idem-key-1');
        assert.equal(input.requestHash, 'hash-1');
        return { type: 'STARTED', recordId: 'idem-1' };
      },
      markCompleted: async (input) => {
        completedCalls.push(input);
      },
    },
    providerRegistryService: {
      getDefaultProvider: () => ({
        authorize: async () => ({
          success: true,
          provider: 'mock',
          providerPaymentId: 'provider-payment-1',
        }),
      }),
    },
  });

  const result = await service.create({
    correlationId: 'correlation-1',
    idempotencyKey: 'idem-key-1',
    merchantId: 'merchant-1',
    amountMinor: 1000,
    currency: 'TRY',
  });

  assert.equal(insertedPayments.length, 1);
  assert.equal(completedCalls.length, 1);
  assert.equal(completedCalls[0].idempotencyRecordId, 'idem-1');
  assert.equal(completedCalls[0].resourceType, 'payment');
  assert.equal(completedCalls[0].resourceId, result.id);
  assert.equal(completedCalls[0].responseStatusCode, 201);
  assert.deepEqual(completedCalls[0].responseBody, result);
  assert.deepEqual(completedCalls[0].trx, { trx: true });
});

test('create stores provider authorization failure response as completed idempotency result', async () => {
  const completedCalls = [];

  const service = new PaymentsService({
    paymentsDataAccess: {
      insert: async (record) => ({
        ...record,
        created_at: '2026-07-08T00:00:00.000Z',
        updated_at: '2026-07-08T00:00:00.000Z',
      }),
      findById: async () => null,
      withTransaction: async (handler) => handler({ trx: true }),
    },
    idempotencyService: {
      buildRequestHash: () => 'hash-1',
      getExistingOrStart: async () => ({ type: 'STARTED', recordId: 'idem-1' }),
      markCompleted: async (input) => {
        completedCalls.push(input);
      },
    },
    providerRegistryService: {
      getDefaultProvider: () => ({
        authorize: async () => ({
          success: false,
          provider: 'mock',
          failureCode: 'MOCK_AUTHORIZATION_FAILED',
          failureMessage: 'Mock provider authorization failure',
        }),
      }),
    },
  });

  const result = await service.create({
    correlationId: 'correlation-1',
    idempotencyKey: 'idem-key-1',
    merchantId: 'merchant-1',
    amountMinor: 9999,
    currency: 'TRY',
  });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.failureCode, 'MOCK_AUTHORIZATION_FAILED');
  assert.equal(completedCalls.length, 1);
  assert.deepEqual(completedCalls[0].responseBody, result);
});

test('create marks idempotency record failed when payment persistence fails', async () => {
  const failedCalls = [];
  const service = new PaymentsService({
    paymentsDataAccess: {
      insert: async () => {
        throw new Error('database unavailable');
      },
      findById: async () => null,
      withTransaction: async (handler) => handler({ trx: true }),
    },
    idempotencyService: {
      buildRequestHash: () => 'hash-1',
      getExistingOrStart: async () => ({ type: 'STARTED', recordId: 'idem-1' }),
      markCompleted: async () => {
        throw new Error('markCompleted should not be called when payment insert fails');
      },
      markFailed: async (input) => {
        failedCalls.push(input);
      },
    },
    providerRegistryService: {
      getDefaultProvider: () => ({
        authorize: async () => ({
          success: true,
          provider: 'mock',
          providerPaymentId: 'provider-payment-1',
        }),
      }),
    },
  });

  await assert.rejects(
    () =>
      service.create({
        correlationId: 'correlation-1',
        idempotencyKey: 'idem-key-1',
        merchantId: 'merchant-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    /database unavailable/,
  );

  assert.deepEqual(failedCalls, [{ idempotencyRecordId: 'idem-1' }]);
});
