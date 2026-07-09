import PaymentServiceClient from '../../src/clients/payment-service-client';

function createClient(fetchFn: jest.Mock, env: NodeJS.ProcessEnv = {}) {
  return new PaymentServiceClient({
    env: {
      PAYMENT_SERVICE_BASE_URL: 'http://payment-service.test',
      INTERNAL_SERVICE_TOKEN: 'internal-token',
      ...env,
    },
    fetchFn: fetchFn as unknown as typeof fetch,
  });
}

describe('PaymentServiceClient', () => {
  it('fails fast when INTERNAL_SERVICE_TOKEN is missing', () => {
    expect(
      () =>
        new PaymentServiceClient({
          env: { PAYMENT_SERVICE_BASE_URL: 'http://payment-service.test' },
        }),
    ).toThrow('INTERNAL_SERVICE_TOKEN is required');
  });

  it('fails fast when PAYMENT_SERVICE_TIMEOUT_MS is invalid', () => {
    expect(() => createClient(jest.fn(), { PAYMENT_SERVICE_TIMEOUT_MS: 'abc' })).toThrow(
      'PAYMENT_SERVICE_TIMEOUT_MS must be a positive number',
    );
    expect(() => createClient(jest.fn(), { PAYMENT_SERVICE_TIMEOUT_MS: '0' })).toThrow(
      'PAYMENT_SERVICE_TIMEOUT_MS must be a positive number',
    );
  });

  it('forwards idempotency key and correlation id to payment service', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ id: 'payment-1' }),
    });

    const client = createClient(fetchMock);

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

    const client = createClient(fetchMock);

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

  it('maps payment service timeout errors to 504 without retrying create', async () => {
    const timeoutError = Object.assign(new Error('operation timed out'), { name: 'TimeoutError' });
    const fetchMock = jest.fn().mockRejectedValue(timeoutError);
    const client = createClient(fetchMock);

    await expect(
      client.create({
        correlationId: 'correlation-1',
        idempotencyKey: 'idem-key-1',
        merchantId: 'merchant-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    ).rejects.toMatchObject({
      statusCode: 504,
      code: 'PAYMENT_SERVICE_TIMEOUT',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps payment service network errors to 502 without retrying create', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = createClient(fetchMock);

    await expect(
      client.create({
        correlationId: 'correlation-1',
        idempotencyKey: 'idem-key-1',
        merchantId: 'merchant-1',
        amountMinor: 1000,
        currency: 'TRY',
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_SERVICE_UNAVAILABLE',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes an abort signal to outbound payment service requests', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ id: 'payment-1' }),
    });
    const client = createClient(fetchMock);

    await client.getById({
      correlationId: 'correlation-1',
      paymentId: 'payment-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://payment-service.test/internal/payments/payment-1',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('retries GET once for transient network errors', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ id: 'payment-1' }),
      });
    const client = createClient(fetchMock);

    await expect(
      client.getById({
        correlationId: 'correlation-1',
        paymentId: 'payment-1',
      }),
    ).resolves.toEqual({ id: 'payment-1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries GET once for timeout errors and then returns the successful response', async () => {
    const timeoutError = Object.assign(new Error('operation timed out'), { name: 'TimeoutError' });
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ id: 'payment-1' }),
      });
    const client = createClient(fetchMock);

    await expect(
      client.getById({
        correlationId: 'correlation-1',
        paymentId: 'payment-1',
      }),
    ).resolves.toEqual({ id: 'payment-1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns 502 when GET retry is exhausted by transport errors', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const client = createClient(fetchMock);

    await expect(
      client.getById({
        correlationId: 'correlation-1',
        paymentId: 'payment-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_SERVICE_UNAVAILABLE',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry GET for HTTP error responses', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: jest.fn().mockResolvedValue({
        error: {
          code: 'PAYMENT_NOT_FOUND',
          message: 'Payment not found',
          details: null,
        },
      }),
    });
    const client = createClient(fetchMock);

    await expect(
      client.getById({
        correlationId: 'correlation-1',
        paymentId: 'payment-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'PAYMENT_NOT_FOUND',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry GET for HTTP 5xx responses', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: jest.fn().mockResolvedValue({
        error: {
          code: 'UPSTREAM_BAD_GATEWAY',
          message: 'Bad gateway',
          details: null,
        },
      }),
    });
    const client = createClient(fetchMock);

    await expect(
      client.getById({
        correlationId: 'correlation-1',
        paymentId: 'payment-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: 'UPSTREAM_BAD_GATEWAY',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
