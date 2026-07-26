const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Joi = require('joi');

const rootDir = path.resolve(__dirname, '..', '..');
const serviceNames = [
  'api-gateway',
  'payment-service',
  'ledger-service',
  'webhook-service',
];

function exists(relativePath) {
  return fs.existsSync(path.join(rootDir, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function buildOpenApiKit() {
  const result = spawnSync(
    'npm',
    ['run', 'build', '--workspace', '@payment-orchestration-platform/openapi-kit'],
    {
      cwd: rootDir,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('OpenAPI utilities live in a single internal workspace package', () => {
  const expectedFiles = [
    'packages/openapi-kit/src/setup-openapi.ts',
    'packages/openapi-kit/src/generate-openapi-document.ts',
    'packages/openapi-kit/src/generate-openapi-paths.ts',
    'packages/openapi-kit/src/joi-to-openapi.ts',
    'packages/openapi-kit/src/types.ts',
  ];

  for (const fileName of expectedFiles) {
    assert.equal(exists(fileName), true);
  }

  for (const serviceName of serviceNames) {
    assert.equal(exists(`services/${serviceName}/src/server/utils/openapi/setup-openapi.ts`), false);
  }
});

test('route settings support response contract metadata in openapi-kit', () => {
  const routeSettings = read('packages/openapi-kit/src/types.ts');

  assert.match(routeSettings, /responses/);
  assert.match(routeSettings, /description/);
  assert.match(routeSettings, /schema/);
  assert.match(routeSettings, /RouteRequestValidation/);
});

test('OpenAPI generator converts route metadata and Joi schemas into a usable contract', () => {
  buildOpenApiKit();

  const { generateOpenApiDocument } = require(path.join(
    rootDir,
    'packages/openapi-kit/dist',
  ));
  const document = generateOpenApiDocument({
    title: 'Contract Test API',
    version: '1.0.0',
    routes: [
      {
        path: '/internal/payments/:paymentId',
        method: 'post',
        controller: 'paymentsController.create',
        config: {
          tags: ['payments'],
          description: 'Create payment contract',
          middlewares: ['internalAuthMiddleware'],
          validation: {
            params: Joi.object({
              paymentId: Joi.string().uuid().required(),
            }),
            query: Joi.object({
              expand: Joi.string().valid('provider', 'ledger').optional(),
            }),
            headers: Joi.object({
              'idempotency-key': Joi.string().min(8).required(),
              'x-correlation-id': Joi.string()
                .min(1)
                .max(128)
                .pattern(/^[!-~]+$/)
                .optional(),
            }).unknown(true),
            body: Joi.object({
              merchantId: Joi.string().uuid().required(),
              amountMinor: Joi.number().integer().positive().required(),
              currency: Joi.string().valid('TRY', 'USD', 'EUR').required(),
            }),
          },
          responses: {
            201: {
              description: 'Payment created',
              schema: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
      },
    ],
  });

  const operation = document.paths['/internal/payments/{paymentId}'].post;

  assert.equal(operation.description, 'Create payment contract');
  assert.deepEqual(operation.tags, ['payments']);
  assert.deepEqual(operation.parameters, [
    {
      name: 'paymentId',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    },
    {
      name: 'expand',
      in: 'query',
      required: false,
      schema: { type: 'string', enum: ['provider', 'ledger'] },
    },
    {
      name: 'idempotency-key',
      in: 'header',
      required: true,
      schema: { type: 'string', minLength: 8 },
    },
    {
      name: 'x-correlation-id',
      in: 'header',
      required: false,
      schema: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[!-~]+$',
      },
    },
  ]);
  assert.deepEqual(operation.requestBody.content['application/json'].schema, {
    type: 'object',
    properties: {
      merchantId: { type: 'string', format: 'uuid' },
      amountMinor: { type: 'integer' },
      currency: { type: 'string', enum: ['TRY', 'USD', 'EUR'] },
    },
    required: ['merchantId', 'amountMinor', 'currency'],
  });
  assert.deepEqual(operation.responses['201'], {
    description: 'Payment created',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
  });
});

test('server applications expose OpenAPI docs through setupOpenApi', () => {
  for (const serviceName of serviceNames) {
    const server = read(`services/${serviceName}/src/server/server.ts`);

    assert.match(server, /setupOpenApi/);
    assert.match(server, /setupSwagger/);
    assert.match(server, /OPENAPI_DOCS_ENABLED/);
    assert.match(server, /routes:\s*Routes/);
  }
});

test('server applications gate CORS with an explicit origin whitelist', () => {
  for (const serviceName of serviceNames) {
    const server = read(`services/${serviceName}/src/server/server.ts`);

    assert.doesNotMatch(server, /cors\(\{\s*origin:\s*['"]\*['"]/);
    assert.match(server, /CORS_ALLOWED_ORIGINS/);
    assert.match(server, /parseAllowedOrigins/);
  }
});

test('payment service routes define non-empty response contracts', () => {
  const routes = read('services/payment-service/src/server/routes/payments/payments.ts');

  assert.match(routes, /responses/);
  assert.match(routes, /201/);
  assert.match(routes, /200/);
  assert.match(routes, /400/);
  assert.match(routes, /401/);
  assert.match(routes, /404/);
  assert.match(routes, /PAYMENT_NOT_FOUND/);
});

test('payment service exposes dynamic OpenAPI JSON from route metadata', () => {
  const setupOpenApi = read('packages/openapi-kit/src/setup-openapi.ts');
  const server = read('services/payment-service/src/server/server.ts');

  assert.match(setupOpenApi, /\.json/);
  assert.match(setupOpenApi, /generateOpenApiDocument/);
  assert.match(setupOpenApi, /routes:\s*options\.routes/);
  assert.match(server, /\/internal-docs/);
});

test('gateway payment client and payment service routes stay aligned with generated contract paths', () => {
  const client = read('services/api-gateway/src/clients/payment-service-client.ts');
  const routes = read('services/payment-service/src/server/routes/payments/payments.ts');

  assert.match(client, /BASE_INTERNAL_API_PATH/);
  assert.match(client, /\/payments/);
  assert.match(routes, /BASE_INTERNAL_API_PATH/);
  assert.match(routes, /\/payments/);
});
