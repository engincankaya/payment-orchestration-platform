import { asValue } from 'awilix';
import request from 'supertest';

import { buildContainer } from '../../src/bootstrap/container';
import { PaymentRoutes } from '../../src/server/routes/payments/payments';
import ServerApplication from '../../src/server/server';

const TEST_ENV = {
  SERVICE_NAME: 'api-gateway',
  PUBLIC_API_KEY: 'public-test-key',
  INTERNAL_SERVICE_TOKEN: 'internal-test-token',
  PAYMENT_SERVICE_BASE_URL: 'http://payment-service.test',
};
const paymentId = '9cfd22b0-c416-45a5-8f93-ed066ac3c3cf';
const captureFailedPayment = {
  id: paymentId,
  merchantId: '0bc5c3bf-3b17-444e-9d92-f3fcb03f1d82',
  amountMinor: 8888,
  currency: 'TRY',
  status: 'CAPTURE_FAILED',
  provider: 'mock-provider',
  providerPaymentId: 'provider-payment-1',
  failureCode: 'CAPTURE_DECLINED',
  failureMessage: 'Capture was declined',
  capturedAt: null,
  createdAt: '2026-07-09T10:00:00.000Z',
};

function createTestServer(fetchFn: jest.Mock = jest.fn(), env: NodeJS.ProcessEnv = {}) {
  const container = buildContainer({
    env: asValue({ ...TEST_ENV, ...env }),
    fetchFn: asValue(fetchFn),
    logger: asValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  });

  return container.resolve<ServerApplication>('server').app;
}

function fetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

describe('API Gateway payment capture HTTP', () => {
  it('rejects unauthenticated capture before exposing validation details', async () => {
    const fetchFn = jest.fn();
    const response = await request(createTestServer(fetchFn))
      .post('/api/v1/payments/not-a-uuid/capture')
      .expect(401);

    expect(response.body).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing API key',
        details: null,
        correlationId: expect.any(String),
      },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not reflect an invalid correlation id in an unauthenticated response', async () => {
    const rejectedCorrelationId = '   ';
    const response = await request(createTestServer())
      .post(`/api/v1/payments/${paymentId}/capture`)
      .set('x-correlation-id', rejectedCorrelationId)
      .expect(401);

    expect(response.headers['x-correlation-id']).toBeUndefined();
    expect(response.body.error.correlationId).toBeNull();
  });

  it.each([
    {
      name: 'missing idempotency key',
      configure: (captureRequest: request.Test) => captureRequest,
    },
    {
      name: 'invalid payment id',
      path: '/api/v1/payments/not-a-uuid/capture',
      configure: (captureRequest: request.Test) =>
        captureRequest.set('idempotency-key', 'idem-capture-1'),
    },
    {
      name: 'empty correlation id',
      hasInvalidCorrelationId: true,
      configure: (captureRequest: request.Test) => captureRequest
        .set('idempotency-key', 'idem-capture-1')
        .set('x-correlation-id', ''),
    },
    {
      name: 'whitespace correlation id',
      hasInvalidCorrelationId: true,
      configure: (captureRequest: request.Test) => captureRequest
        .set('idempotency-key', 'idem-capture-1')
        .set('x-correlation-id', '   '),
    },
    {
      name: 'overlong correlation id',
      hasInvalidCorrelationId: true,
      configure: (captureRequest: request.Test) => captureRequest
        .set('idempotency-key', 'idem-capture-1')
        .set('x-correlation-id', 'a'.repeat(129)),
    },
  ])(
    'rejects $name before calling payment service',
    async ({ path, configure, hasInvalidCorrelationId }) => {
      const fetchFn = jest.fn();
      const captureRequest = request(createTestServer(fetchFn))
        .post(path ?? `/api/v1/payments/${paymentId}/capture`)
        .set('x-api-key', TEST_ENV.PUBLIC_API_KEY);

      const response = await configure(captureRequest).expect(400);

      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
      });
      if (hasInvalidCorrelationId) {
        expect(response.headers['x-correlation-id']).toBeUndefined();
        expect(response.body.error.correlationId).toBeNull();
      } else {
        expect(response.body.error.correlationId).toEqual(expect.any(String));
      }
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('returns CAPTURE_FAILED as a successful result and preserves correlation id', async () => {
    const fetchFn = jest.fn().mockResolvedValue(fetchResponse(200, captureFailedPayment));
    const correlationId = 'merchant-trace-capture-01';

    const response = await request(createTestServer(fetchFn))
      .post(`/api/v1/payments/${paymentId}/capture`)
      .set('x-api-key', TEST_ENV.PUBLIC_API_KEY)
      .set('idempotency-key', 'idem-capture-1')
      .set('x-correlation-id', correlationId)
      .expect(200);

    expect(response.body).toEqual({
      data: captureFailedPayment,
      correlationId,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      `http://payment-service.test/internal/payments/${paymentId}/capture`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'idempotency-key': 'idem-capture-1',
          'x-correlation-id': correlationId,
          'x-internal-token': TEST_ENV.INTERNAL_SERVICE_TOKEN,
        }),
      }),
    );
  });

  it.each([
    { statusCode: 404, code: 'PAYMENT_NOT_FOUND', message: 'Payment not found' },
    { statusCode: 409, code: 'PAYMENT_NOT_CAPTURABLE', message: 'Payment cannot be captured' },
  ])(
    'preserves upstream $statusCode $code response',
    async ({ statusCode, code, message }) => {
      const fetchFn = jest.fn().mockResolvedValue(fetchResponse(statusCode, {
        error: { code, message, details: null },
      }));

      const response = await request(createTestServer(fetchFn))
        .post(`/api/v1/payments/${paymentId}/capture`)
        .set('x-api-key', TEST_ENV.PUBLIC_API_KEY)
        .set('idempotency-key', 'idem-capture-1')
        .expect(statusCode);

      expect(response.body.error).toMatchObject({ code, message });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it('maps capture timeout to 504 without retrying', async () => {
    const timeoutError = Object.assign(new Error('operation timed out'), { name: 'TimeoutError' });
    const fetchFn = jest.fn().mockRejectedValue(timeoutError);

    const response = await request(createTestServer(fetchFn))
      .post(`/api/v1/payments/${paymentId}/capture`)
      .set('x-api-key', TEST_ENV.PUBLIC_API_KEY)
      .set('idempotency-key', 'idem-capture-1')
      .expect(504);

    expect(response.body.error).toMatchObject({
      code: 'PAYMENT_SERVICE_TIMEOUT',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('generates a correlation id only when the header is missing', async () => {
    const fetchFn = jest.fn().mockResolvedValue(fetchResponse(200, captureFailedPayment));

    const response = await request(createTestServer(fetchFn))
      .post(`/api/v1/payments/${paymentId}/capture`)
      .set('x-api-key', TEST_ENV.PUBLIC_API_KEY)
      .set('idempotency-key', 'idem-capture-1')
      .expect(200);

    expect(response.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(fetchFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-correlation-id': response.body.correlationId,
        }),
      }),
    );
  });

  it('uses the same bounded correlation header contract on every payment route', () => {
    const businessRoutes = [
      ['post', '/api/v1/payments'],
      ['get', '/api/v1/payments/:paymentId'],
      ['post', '/api/v1/payments/:paymentId/capture'],
    ] as const;

    for (const [method, path] of businessRoutes) {
      const route = PaymentRoutes.find((candidate) =>
        candidate.method === method && candidate.path === path);
      expect(route).toBeDefined();
      if (!route) {
        continue;
      }
      const schema = route.config.validation.headers;
      if (!schema) {
        throw new Error(`Missing header validation for ${route.method.toUpperCase()} ${route.path}`);
      }
      const baseHeaders = {
        'x-api-key': TEST_ENV.PUBLIC_API_KEY,
        ...(route.method === 'post' ? { 'idempotency-key': 'idem-route-contract' } : {}),
      };

      for (const value of ['!', 'a'.repeat(128)]) {
        expect(schema.validate({
          ...baseHeaders,
          'x-correlation-id': value,
        }).error).toBeUndefined();
      }

      for (const value of ['', ' ', 'trace with spaces', 'trace\tcontrol', 'a'.repeat(129)]) {
        expect(schema.validate({
          ...baseHeaders,
          'x-correlation-id': value,
        }).error).toBeDefined();
      }
    }
  });

  it('publishes the capture route and lifecycle response contract in OpenAPI', async () => {
    const response = await request(createTestServer(jest.fn(), {
      OPENAPI_DOCS_ENABLED: 'true',
    }))
      .get('/api-docs.json')
      .expect(200);
    const operation = response.body.paths[`/api/v1/payments/{paymentId}/capture`]?.post;

    expect(operation).toBeDefined();
    expect(Object.keys(operation.responses).sort()).toEqual(
      ['200', '400', '401', '404', '409', '502', '504'],
    );
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'x-api-key',
        in: 'header',
        required: true,
      }),
      expect.objectContaining({
        name: 'idempotency-key',
        in: 'header',
        required: true,
      }),
      expect.objectContaining({
        name: 'x-correlation-id',
        in: 'header',
        required: false,
        schema: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[!-~]+$',
        },
      }),
    ]));

    const paymentOperations = [
      [response.body.paths['/api/v1/payments']?.post, '201'],
      [response.body.paths['/api/v1/payments/{paymentId}']?.get, '200'],
      [operation, '200'],
    ] as const;
    for (const [paymentOperation, successStatus] of paymentOperations) {
      expect(paymentOperation).toBeDefined();
      if (!paymentOperation) {
        continue;
      }
      const paymentSchema = paymentOperation.responses[successStatus]
        .content['application/json'].schema.properties.data;
      expect(paymentSchema.properties.status.enum).toEqual([
        'CREATED',
        'AUTHORIZED',
        'FAILED',
        'CAPTURED',
        'CAPTURE_FAILED',
      ]);
      expect(paymentSchema.properties.capturedAt).toEqual({
        type: 'string',
        format: 'date-time',
        nullable: true,
      });
      expect(paymentSchema.required).not.toContain('capturedAt');
    }
  });
});
