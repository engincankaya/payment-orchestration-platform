import PaymentServiceClient from '../../src/clients/payment-service-client';

describe('PaymentServiceClient', () => {
  it('fails fast when INTERNAL_SERVICE_TOKEN is missing', () => {
    expect(
      () =>
        new PaymentServiceClient({
          env: { PAYMENT_SERVICE_BASE_URL: 'http://payment-service.test' },
        }),
    ).toThrow('INTERNAL_SERVICE_TOKEN is required');
  });

  it('forwards idempotency key and correlation id to payment service', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ id: 'payment-1' }),
    });

    const client = new PaymentServiceClient({
      env: {
        PAYMENT_SERVICE_BASE_URL: 'http://payment-service.test',
        INTERNAL_SERVICE_TOKEN: 'internal-token',
      },
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await client.create({
      correlationId: 'correlation-1',
      idempotencyKey: 'idem-key-1',
      merchantId: 'merchant-1',
      amountMinor: 1000,
      currency: 'TRY',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://payment-service.test/internal/payments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'idempotency-key': 'idem-key-1',
          'x-correlation-id': 'correlation-1',
          'x-internal-token': 'internal-token',
        }),
        body: JSON.stringify({
          merchantId: 'merchant-1',
          amountMinor: 1000,
          currency: 'TRY',
        }),
      }),
    );
  });

  it('maps payment service idempotency conflict without retrying', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: jest.fn().mockResolvedValue({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
          message: 'Idempotency key was reused with a different request',
          details: null,
        },
      }),
    });

    const client = new PaymentServiceClient({
      env: {
        PAYMENT_SERVICE_BASE_URL: 'http://payment-service.test',
        INTERNAL_SERVICE_TOKEN: 'internal-token',
      },
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.create({
        correlationId: 'correlation-1',
        idempotencyKey: 'idem-key-1',
        merchantId: 'merchant-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
