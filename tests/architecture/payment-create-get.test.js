const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..', '..');

function exists(relativePath) {
  return fs.existsSync(path.join(rootDir, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('payment-service owns create/get payment route, controller, service and data-access files', () => {
  const expectedFiles = [
    'services/payment-service/src/server/routes/payments/index.ts',
    'services/payment-service/src/server/routes/payments/payments.ts',
    'services/payment-service/src/server/controllers/payments/payments-controller.ts',
    'services/payment-service/src/services/payments/payments-service.ts',
    'services/payment-service/src/data-access/payments/payments-data-access.ts',
    'services/payment-service/src/bootstrap/knex/migrations/001_create_payments.ts',
  ];

  for (const filePath of expectedFiles) {
    assert.equal(exists(filePath), true, `${filePath} is missing`);
  }
});

test('payment-service provider integration is behind adapter and registry boundaries', () => {
  const expectedFiles = [
    'services/payment-service/src/services/providers/payment-provider.ts',
    'services/payment-service/src/services/providers/mock-payment-provider.ts',
    'services/payment-service/src/services/providers/provider-registry-service.ts',
  ];

  for (const filePath of expectedFiles) {
    assert.equal(exists(filePath), true, `${filePath} is missing`);
  }

  const paymentsService = read('services/payment-service/src/services/payments/payments-service.ts');

  assert.match(paymentsService, /providerRegistryService/);
  assert.doesNotMatch(paymentsService, /new MockPaymentProvider/);
});

test('payment-service create route validates money, currency, headers and internal auth', () => {
  const routes = read('services/payment-service/src/server/routes/payments/payments.ts');

  assert.match(routes, /POST|method:\s*'post'/);
  assert.match(routes, /BASE_INTERNAL_API_PATH/);
  assert.match(routes, /\/payments/);
  assert.match(routes, /internalAuthMiddleware/);
  assert.match(routes, /idempotency-key/);
  assert.match(routes, /amountMinor/);
  assert.match(routes, /AMOUNT_MINOR_MAX\s*=\s*1_000_000_000_000/);
  assert.match(routes, /\.integer\(\)\.positive\(\)/);
  assert.match(routes, /valid\('TRY',\s*'USD',\s*'EUR'\)/);
  assert.match(routes, /\.unknown\(true\)/);
});

test('api-gateway owns external payment routes, auth middleware, service and payment client', () => {
  const expectedFiles = [
    'services/api-gateway/src/server/routes/payments/index.ts',
    'services/api-gateway/src/server/routes/payments/payments.ts',
    'services/api-gateway/src/server/controllers/payments/payments-controller.ts',
    'services/api-gateway/src/server/middlewares/api-key-auth-middleware.ts',
    'services/api-gateway/src/services/auth/external-auth-service.ts',
    'services/api-gateway/src/services/auth/api-key-auth-provider.ts',
    'services/api-gateway/src/services/payments-gateway-service.ts',
    'services/api-gateway/src/clients/payment-service-client.ts',
  ];

  for (const filePath of expectedFiles) {
    assert.equal(exists(filePath), true, `${filePath} is missing`);
  }
});

test('api-gateway payment client propagates internal auth, correlation id and idempotency key', () => {
  const client = read('services/api-gateway/src/clients/payment-service-client.ts');

  assert.match(client, /x-internal-token/);
  assert.match(client, /CORRELATION_ID_HEADER/);
  assert.match(client, /idempotency-key/);
  assert.match(client, /PAYMENT_SERVICE_BASE_URL/);
});

test('gateway does not introduce database access for payment create/get', () => {
  const gatewayRoutes = read('services/api-gateway/src/server/routes/payments/payments.ts');
  const gatewayService = read('services/api-gateway/src/services/payments-gateway-service.ts');

  assert.doesNotMatch(gatewayRoutes, /knex|DataAccess|paymentsDataAccess/);
  assert.doesNotMatch(gatewayService, /knex|DataAccess|paymentsDataAccess/);
  assert.match(gatewayRoutes, /AMOUNT_MINOR_MAX\s*=\s*1_000_000_000_000/);
});
