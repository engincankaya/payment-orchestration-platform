const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

test('OpenAPI generator maps route metadata, path params, headers and request body', () => {
  const generator = read('packages/openapi-kit/src/generate-openapi-paths.ts');

  assert.match(generator, /replace\(/);
  assert.match(generator, /parameters/);
  assert.match(generator, /header/);
  assert.match(generator, /path/);
  assert.match(generator, /query/);
  assert.match(generator, /requestBody/);
  assert.match(generator, /responses/);
  assert.match(generator, /config\.description/);
  assert.match(generator, /config\.tags/);
});

test('server applications expose OpenAPI docs through setupOpenApi', () => {
  for (const serviceName of serviceNames) {
    const server = read(`services/${serviceName}/src/server/server.ts`);

    assert.match(server, /setupOpenApi/);
    assert.match(server, /setupSwagger/);
    assert.match(server, /routes:\s*Routes/);
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

  assert.match(client, /\/internal\/payments/);
  assert.match(routes, /BASE_INTERNAL_API_PATH/);
  assert.match(routes, /\/payments/);
});
