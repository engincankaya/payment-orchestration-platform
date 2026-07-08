const assert = require('node:assert/strict');
const test = require('node:test');

const PaymentServiceClient = require('../../dist/clients/payment-service-client').default;

test('create forwards idempotency key and correlation id to payment service', async () => {
  const calls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ id: 'payment-1' }),
    };
  };

  try {
    const client = new PaymentServiceClient({
      env: {
        PAYMENT_SERVICE_BASE_URL: 'http://payment-service.test',
        INTERNAL_SERVICE_TOKEN: 'internal-token',
      },
    });

    await client.create({
      correlationId: 'correlation-1',
      idempotencyKey: 'idem-key-1',
      merchantId: 'merchant-1',
      amountMinor: 1000,
      currency: 'TRY',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://payment-service.test/internal/payments');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['idempotency-key'], 'idem-key-1');
    assert.equal(calls[0].options.headers['x-correlation-id'], 'correlation-1');
    assert.equal(calls[0].options.headers['x-internal-token'], 'internal-token');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      merchantId: 'merchant-1',
      amountMinor: 1000,
      currency: 'TRY',
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('create maps payment service idempotency conflict without retrying', async () => {
  let callCount = 0;
  const previousFetch = global.fetch;
  global.fetch = async () => {
    callCount += 1;
    return {
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
          message: 'Idempotency key was reused with a different request',
          details: null,
        },
      }),
    };
  };

  try {
    const client = new PaymentServiceClient({
      env: {
        PAYMENT_SERVICE_BASE_URL: 'http://payment-service.test',
        INTERNAL_SERVICE_TOKEN: 'internal-token',
      },
    });

    await assert.rejects(
      () =>
        client.create({
          correlationId: 'correlation-1',
          idempotencyKey: 'idem-key-1',
          merchantId: 'merchant-1',
          amountMinor: 1000,
          currency: 'TRY',
        }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
        return true;
      },
    );

    assert.equal(callCount, 1);
  } finally {
    global.fetch = previousFetch;
  }
});
