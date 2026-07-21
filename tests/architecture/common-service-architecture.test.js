const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..', '..');
const servicesDir = path.join(rootDir, 'services');
const serviceNames = [
  'api-gateway',
  'payment-service',
  'ledger-service',
  'webhook-service',
];

const commonArchitectureFiles = [
  'src/bootstrap/container.ts',
  'src/bootstrap/knex/knex.ts',
  'src/bootstrap/knex/knexfile.ts',
  'src/constants/index.ts',
  'src/data-access/base-data-access.ts',
  'src/server/init-custom-routes.ts',
  'src/server/routes/index.ts',
  'src/server/middlewares/correlation-id-middleware.ts',
  'src/server/middlewares/error-middleware.ts',
  'src/server/validations/common-validations.ts',
  'src/types/errors/api-error.ts',
  'src/utils/logger.ts',
];

function readServiceFile(serviceName, relativePath) {
  return fs.readFileSync(path.join(servicesDir, serviceName, relativePath), 'utf8');
}

function serviceFileExists(serviceName, relativePath) {
  return fs.existsSync(path.join(servicesDir, serviceName, relativePath));
}

test('each service owns a local copy of the common service architecture files', () => {
  for (const serviceName of serviceNames) {
    for (const fileName of commonArchitectureFiles) {
      assert.equal(
        serviceFileExists(serviceName, fileName),
        true,
        `${serviceName}/${fileName} is missing`,
      );
    }
  }
});

test('each service package includes the common architecture runtime dependencies', () => {
  const requiredDependencies = [
    '@payment-orchestration-platform/openapi-kit',
    'awilix',
    'cors',
    'express',
    'joi',
    'knex',
    'pg',
  ];

  for (const serviceName of serviceNames) {
    const packageJson = JSON.parse(readServiceFile(serviceName, 'package.json'));

    for (const dependencyName of requiredDependencies) {
      assert.equal(
        packageJson.dependencies?.[dependencyName] !== undefined,
        true,
        `${serviceName} is missing dependency ${dependencyName}`,
      );
    }
  }
});

test('containers use Awilix proxy injection and enforce required lifetimes', () => {
  for (const serviceName of serviceNames) {
    const containerSource = readServiceFile(serviceName, 'src/bootstrap/container.ts');

    assert.match(containerSource, /InjectionMode\.PROXY/);
    assert.match(containerSource, /export function buildContainer/);
    assert.match(containerSource, /overrides:\s*NameAndRegistrationPair<unknown>\s*=\s*\{\}/);
    assert.match(containerSource, /server:\s*asClass\(ServerApplication\)\.singleton\(\)/);
    assert.match(containerSource, /knex:\s*asValue\(knex\)/);
    assert.match(containerSource, /env:\s*asValue\(process\.env\)/);
    assert.match(containerSource, /resolverOptions:\s*\{\s*lifetime:\s*Lifetime\.SINGLETON\s*\}/);
    assert.match(containerSource, /resolverOptions:\s*\{\s*lifetime:\s*Lifetime\.SCOPED\s*\}/);
    assert.match(containerSource, /container\.register\(overrides\)/);
    assert.match(containerSource, /export default buildContainer\(\)/);
  }
});

test('server application registers middleware, routes, error handling and health in order', () => {
  for (const serviceName of serviceNames) {
    const serverSource = readServiceFile(serviceName, 'src/server/server.ts');
    const globalMiddlewareIndex = serverSource.indexOf('registerMiddlewares');
    const routesIndex = serverSource.indexOf('registerRoutes');
    const afterMiddlewareIndex = serverSource.indexOf('registerAfterMiddlewares');
    const swaggerIndex = serverSource.indexOf('setupSwagger');

    assert.match(serverSource, /export default class ServerApplication/);
    assert.match(serverSource, /initCustomRoutes\(this\.app,\s*this\.container\)/);
    assert.match(serverSource, /this\.app\.use\(this\.errorMiddleware\)/);
    assert.match(serverSource, /app\.get\(['"]\/health['"]/);
    assert.equal(globalMiddlewareIndex < routesIndex, true);
    assert.equal(routesIndex < afterMiddlewareIndex, true);
    assert.equal(afterMiddlewareIndex < swaggerIndex, true);
  }
});

test('init custom routes validates metadata and fails fast at startup', () => {
  for (const serviceName of serviceNames) {
    const routeSource = readServiceFile(serviceName, 'src/server/init-custom-routes.ts');

    assert.match(routeSource, /split\('\.'\)/);
    assert.match(routeSource, /Invalid route controller/);
    assert.match(routeSource, /Controller not found/);
    assert.match(routeSource, /Controller method not found/);
    assert.match(routeSource, /Middleware not found/);
    assert.match(routeSource, /Unsupported HTTP method/);
    assert.match(routeSource, /createValidationHandler/);
    assert.match(routeSource, /path,\s*\.\.\.middlewares,\s*validationHandler,\s*controllerFunction/);
  }
});

test('validation errors use the required response shape and do not call next after response', () => {
  for (const serviceName of serviceNames) {
    const validationSource = readServiceFile(
      serviceName,
      'src/server/validations/common-validations.ts',
    );

    assert.match(validationSource, /VALIDATION_ERROR/);
    assert.match(validationSource, /Validation failed/);
    assert.match(validationSource, /correlationId/);
    assert.match(validationSource, /return res\.status\(400\)\.json/);
    const validationErrorIndex = validationSource.indexOf("code: 'VALIDATION_ERROR'");
    const successNextIndex = validationSource.indexOf('return next();');

    assert.notEqual(validationErrorIndex, -1);
    assert.notEqual(successNextIndex, -1);
    assert.equal(validationErrorIndex < successNextIndex, true);
  }
});

test('correlation and error middleware follow the required response standards', () => {
  for (const serviceName of serviceNames) {
    const correlationSource = readServiceFile(
      serviceName,
      'src/server/middlewares/correlation-id-middleware.ts',
    );
    const errorSource = readServiceFile(serviceName, 'src/server/middlewares/error-middleware.ts');

    assert.match(correlationSource, /CORRELATION_ID_HEADER/);
    assert.match(correlationSource, /randomUUID/);
    assert.match(errorSource, /instanceof ApiError/);
    assert.match(errorSource, /INTERNAL_SERVER_ERROR/);
    assert.match(errorSource, /correlationId/);
    assert.match(errorSource, /deps\.logger\.error/);
    assert.match(errorSource, /message:\s*error instanceof Error/);
    assert.match(errorSource, /stack:\s*error instanceof Error/);
  }
});
