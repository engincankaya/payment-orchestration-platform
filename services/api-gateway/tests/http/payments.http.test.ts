import { asValue } from 'awilix';
import request from 'supertest';

import { buildContainer } from '../../src/bootstrap/container';
import { AMOUNT_MINOR_MAX } from '../../src/server/routes/payments/payments';
import ServerApplication from '../../src/server/server';

const TEST_ENV = {
  SERVICE_NAME: 'api-gateway',
  PUBLIC_API_KEY: 'public-test-key',
  INTERNAL_SERVICE_TOKEN: 'internal-test-token',
  PAYMENT_SERVICE_BASE_URL: 'http://payment-service.test',
};

function createTestServer(fetchFn: jest.Mock = jest.fn(), env: NodeJS.ProcessEnv = {}) {
  const container = buildContainer({
    env: asValue({ ...TEST_ENV, ...env }),
    fetchFn: asValue(fetchFn),
  });

  return container.resolve<ServerApplication>('server').app;
}

describe('API Gateway HTTP', () => {
  it('serves health checks through the real app', async () => {
    const response = await request(createTestServer()).get('/health').expect(200);

    expect(response.headers['x-correlation-id']).toEqual(expect.any(String));
    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('does not expose OpenAPI docs unless explicitly enabled', async () => {
    await request(createTestServer()).get('/api-docs.json').expect(404);
  });

  it('exposes OpenAPI docs when explicitly enabled', async () => {
    const response = await request(createTestServer(jest.fn(), {
      OPENAPI_DOCS_ENABLED: 'true',
    }))
      .get('/api-docs.json')
      .expect(200);

    expect(response.body.openapi).toMatch(/^3\.0\./);
    expect(response.body.info).toEqual(expect.objectContaining({
      title: 'api-gateway API',
    }));
  });

  it('does not emit CORS allow-origin when no origin whitelist is configured', async () => {
    const response = await request(createTestServer())
      .get('/health')
      .set('Origin', 'https://merchant.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows whitelisted CORS origins only', async () => {
    const app = createTestServer(jest.fn(), {
      CORS_ALLOWED_ORIGINS: 'https://merchant.example, https://admin.example',
    });

    const allowed = await request(app)
      .get('/health')
      .set('Origin', 'https://merchant.example')
      .expect(200);
    const denied = await request(app)
      .get('/health')
      .set('Origin', 'https://unknown.example')
      .expect(200);

    expect(allowed.headers['access-control-allow-origin']).toBe('https://merchant.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects unauthenticated payment create before request validation', async () => {
    const response = await request(createTestServer())
      .post('/api/v1/payments')
      .send({ amountMinor: 'not-a-number' })
      .expect(401);

    expect(response.body).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing API key',
        details: null,
        correlationId: expect.any(String),
      },
    });
  });

  it('returns validation errors after API key authentication succeeds', async () => {
    const response = await request(createTestServer())
      .post('/api/v1/payments')
      .set('x-api-key', TEST_ENV.PUBLIC_API_KEY)
      .set('idempotency-key', 'idem-key-1')
      .send({ amountMinor: 'not-a-number' })
      .expect(400);

    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      correlationId: expect.any(String),
    });
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringMatching(/^body\./),
        }),
      ]),
    );
  });

  it('rejects payment create when amountMinor is above the maximum', async () => {
    const fetchFn = jest.fn();
    const response = await request(createTestServer(fetchFn))
      .post('/api/v1/payments')
      .set('x-api-key', TEST_ENV.PUBLIC_API_KEY)
      .set('idempotency-key', 'idem-key-1')
      .send({
        merchantId: '0bc5c3bf-3b17-444e-9d92-f3fcb03f1d82',
        amountMinor: AMOUNT_MINOR_MAX + 1,
        currency: 'TRY',
      })
      .expect(400);

    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
    });
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'body.amountMinor',
        }),
      ]),
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('accepts payment create when amountMinor is exactly the maximum', async () => {
    const paymentResponse = {
      id: '9cfd22b0-c416-45a5-8f93-ed066ac3c3cf',
      merchantId: '0bc5c3bf-3b17-444e-9d92-f3fcb03f1d82',
      amountMinor: AMOUNT_MINOR_MAX,
      currency: 'TRY',
      status: 'AUTHORIZED',
      provider: 'mock-provider',
      providerPaymentId: 'provider-payment-1',
      failureCode: null,
      failureMessage: null,
      createdAt: '2026-07-09T10:00:00.000Z',
    };
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue(paymentResponse),
    });

    await request(createTestServer(fetchFn))
      .post('/api/v1/payments')
      .set('x-api-key', TEST_ENV.PUBLIC_API_KEY)
      .set('idempotency-key', 'idem-key-1')
      .send({
        merchantId: paymentResponse.merchantId,
        amountMinor: AMOUNT_MINOR_MAX,
        currency: paymentResponse.currency,
      })
      .expect(201);

    expect(fetchFn).toHaveBeenCalledWith(
      'http://payment-service.test/internal/payments',
      expect.objectContaining({
        body: JSON.stringify({
          merchantId: paymentResponse.merchantId,
          amountMinor: AMOUNT_MINOR_MAX,
          currency: paymentResponse.currency,
        }),
      }),
    );
  });

  it('reaches the payment service HTTP boundary for authenticated valid create requests', async () => {
    const paymentResponse = {
      id: '9cfd22b0-c416-45a5-8f93-ed066ac3c3cf',
      merchantId: '0bc5c3bf-3b17-444e-9d92-f3fcb03f1d82',
      amountMinor: 1000,
      currency: 'TRY',
      status: 'AUTHORIZED',
      provider: 'mock-provider',
      providerPaymentId: 'provider-payment-1',
      failureCode: null,
      failureMessage: null,
      createdAt: '2026-07-09T10:00:00.000Z',
    };
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue(paymentResponse),
    });

    const response = await request(createTestServer(fetchFn))
      .post('/api/v1/payments')
      .set('x-api-key', TEST_ENV.PUBLIC_API_KEY)
      .set('idempotency-key', 'idem-key-1')
      .send({
        merchantId: paymentResponse.merchantId,
        amountMinor: paymentResponse.amountMinor,
        currency: paymentResponse.currency,
      })
      .expect(201);

    expect(response.body).toEqual({
      data: paymentResponse,
      correlationId: expect.any(String),
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://payment-service.test/internal/payments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-internal-token': TEST_ENV.INTERNAL_SERVICE_TOKEN,
          'idempotency-key': 'idem-key-1',
          'x-correlation-id': response.body.correlationId,
        }),
      }),
    );
  });

  it('preserves payment service create response status for authenticated valid requests', async () => {
    const paymentResponse = {
      id: '9cfd22b0-c416-45a5-8f93-ed066ac3c3cf',
      merchantId: '0bc5c3bf-3b17-444e-9d92-f3fcb03f1d82',
      amountMinor: 1000,
      currency: 'TRY',
      status: 'AUTHORIZED',
      provider: 'mock-provider',
      providerPaymentId: 'provider-payment-1',
      failureCode: null,
      failureMessage: null,
      createdAt: '2026-07-09T10:00:00.000Z',
    };
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: jest.fn().mockResolvedValue(paymentResponse),
    });

    const response = await request(createTestServer(fetchFn))
      .post('/api/v1/payments')
      .set('x-api-key', TEST_ENV.PUBLIC_API_KEY)
      .set('idempotency-key', 'idem-key-1')
      .send({
        merchantId: paymentResponse.merchantId,
        amountMinor: paymentResponse.amountMinor,
        currency: paymentResponse.currency,
      })
      .expect(202);

    expect(response.body).toEqual({
      data: paymentResponse,
      correlationId: expect.any(String),
    });
  });
});
