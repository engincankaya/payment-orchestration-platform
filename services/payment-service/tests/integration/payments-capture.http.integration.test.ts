import { asValue } from 'awilix';
import request from 'supertest';

import { buildContainer } from '../../src/bootstrap/container';
import { PaymentRoutes } from '../../src/server/routes/payments/payments';
import ServerApplication from '../../src/server/server';

const TEST_ENV = {
  SERVICE_NAME: 'payment-service',
  INTERNAL_SERVICE_TOKEN: 'internal-test-token',
};
const paymentId = '9cfd22b0-c416-45a5-8f93-ed066ac3c3cf';
const capturedPayment = {
  id: paymentId,
  merchantId: '0bc5c3bf-3b17-444e-9d92-f3fcb03f1d82',
  amountMinor: 1000,
  currency: 'TRY',
  status: 'CAPTURED',
  provider: 'mock-provider',
  providerPaymentId: 'provider-payment-1',
  failureCode: null,
  failureMessage: null,
  capturedAt: '2026-07-26T10:00:00.000Z',
  createdAt: '2026-07-09T10:00:00.000Z',
};

function createPaymentsServiceFake() {
  return {
    create: jest.fn(),
    getById: jest.fn(),
    capture: jest.fn(),
  };
}

function createTestServer(
  paymentsService = createPaymentsServiceFake(),
  env: NodeJS.ProcessEnv = {},
) {
  const container = buildContainer({
    env: asValue({ ...TEST_ENV, ...env }),
    logger: asValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
    paymentsService: asValue(paymentsService),
  });

  return {
    app: container.resolve<ServerApplication>('server').app,
    paymentsService,
  };
}

describe('Payment Service capture HTTP integration', () => {
  it('rejects unauthenticated capture before exposing validation details', async () => {
    const { app, paymentsService } = createTestServer();
    const response = await request(app)
      .post('/internal/payments/not-a-uuid/capture')
      .expect(401);

    expect(response.body).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing internal token',
        details: null,
        correlationId: expect.any(String),
      },
    });
    expect(paymentsService.capture).not.toHaveBeenCalled();
  });

  it('does not reflect an invalid correlation id in an unauthenticated response', async () => {
    const rejectedCorrelationId = '   ';
    const { app, paymentsService } = createTestServer();
    const response = await request(app)
      .post(`/internal/payments/${paymentId}/capture`)
      .set('x-correlation-id', rejectedCorrelationId)
      .expect(401);

    expect(response.headers['x-correlation-id']).toBeUndefined();
    expect(response.body.error.correlationId).toBeNull();
    expect(paymentsService.capture).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing idempotency key',
      configure: (captureRequest: request.Test) => captureRequest,
    },
    {
      name: 'invalid payment id',
      path: '/internal/payments/not-a-uuid/capture',
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
    'rejects $name before invoking the payment service',
    async ({ path, configure, hasInvalidCorrelationId }) => {
      const { app, paymentsService } = createTestServer();
      const captureRequest = request(app)
        .post(path ?? `/internal/payments/${paymentId}/capture`)
        .set('x-internal-token', TEST_ENV.INTERNAL_SERVICE_TOKEN);

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
      expect(paymentsService.capture).not.toHaveBeenCalled();
    },
  );

  it('passes a validated capture command to PaymentsService and preserves its response', async () => {
    const paymentsService = createPaymentsServiceFake();
    paymentsService.capture.mockResolvedValue({
      statusCode: 200,
      body: capturedPayment,
    });
    const { app } = createTestServer(paymentsService);
    const correlationId = 'gateway-trace-capture-01';

    const response = await request(app)
      .post(`/internal/payments/${paymentId}/capture`)
      .set('x-internal-token', TEST_ENV.INTERNAL_SERVICE_TOKEN)
      .set('idempotency-key', 'idem-capture-1')
      .set('x-correlation-id', correlationId)
      .expect(200);

    expect(response.body).toEqual(capturedPayment);
    expect(paymentsService.capture).toHaveBeenCalledTimes(1);
    expect(paymentsService.capture).toHaveBeenCalledWith({
      correlationId,
      idempotencyKey: 'idem-capture-1',
      paymentId,
    });
  });

  it('uses the same bounded correlation header contract on every payment route', () => {
    const businessRoutes = [
      ['post', '/internal/payments'],
      ['get', '/internal/payments/:paymentId'],
      ['post', '/internal/payments/:paymentId/capture'],
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
        'x-internal-token': TEST_ENV.INTERNAL_SERVICE_TOKEN,
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

  it('publishes the internal capture route and lifecycle response contract in OpenAPI', async () => {
    const { app } = createTestServer(createPaymentsServiceFake(), {
      OPENAPI_DOCS_ENABLED: 'true',
    });
    const response = await request(app)
      .get('/internal-docs.json')
      .expect(200);
    const operation = response.body.paths[`/internal/payments/{paymentId}/capture`]?.post;

    expect(operation).toBeDefined();
    expect(Object.keys(operation.responses).sort()).toEqual(
      ['200', '400', '401', '404', '409'],
    );
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'x-internal-token',
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
      [response.body.paths['/internal/payments']?.post, '201'],
      [response.body.paths['/internal/payments/{paymentId}']?.get, '200'],
      [operation, '200'],
    ] as const;
    for (const [paymentOperation, successStatus] of paymentOperations) {
      expect(paymentOperation).toBeDefined();
      if (!paymentOperation) {
        continue;
      }
      const paymentSchema = paymentOperation.responses[successStatus]
        .content['application/json'].schema;
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
