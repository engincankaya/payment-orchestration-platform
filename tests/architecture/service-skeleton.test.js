const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..', '..');
const servicesDir = path.join(rootDir, 'services');

const expectedServices = [
  'api-gateway',
  'payment-service',
  'ledger-service',
  'webhook-service',
];

const expectedServiceFiles = [
  'package.json',
  'tsconfig.json',
  'Dockerfile',
  'src/index.ts',
  'src/server/server.ts',
];

function readFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('phase 0 service directories and core files exist', () => {
  for (const serviceName of expectedServices) {
    for (const fileName of expectedServiceFiles) {
      const filePath = path.join(servicesDir, serviceName, fileName);
      assert.equal(fs.existsSync(filePath), true, `${serviceName}/${fileName} is missing`);
    }
  }
});

test('each service package is independently runnable and private', () => {
  for (const serviceName of expectedServices) {
    const packageJson = JSON.parse(readFile(`services/${serviceName}/package.json`));

    assert.equal(packageJson.private, true);
    assert.equal(packageJson.name, `@payment-orchestration-platform/${serviceName}`);
    assert.equal(typeof packageJson.scripts?.dev, 'string');
    assert.equal(typeof packageJson.scripts?.build, 'string');
    assert.equal(typeof packageJson.scripts?.start, 'string');
    assert.equal(packageJson.dependencies?.express !== undefined, true);
  }
});

test('each service exposes a health route in its bootstrap server', () => {
  for (const serviceName of expectedServices) {
    const serverSource = readFile(`services/${serviceName}/src/server/server.ts`);

    assert.match(serverSource, /app\.get\(['"]\/health['"]|this\.app\.get\(['"]\/health['"]/);
    assert.match(serverSource, /status:\s*['"]ok['"]/);
  }
});

test('http services default to production-like container port 8080', () => {
  for (const serviceName of expectedServices) {
    const startupSource = serviceName === 'payment-service'
      ? readFile('services/payment-service/src/bootstrap/payment-service-bootstrap.ts')
      : readFile(`services/${serviceName}/src/index.ts`);
    const dockerfileSource = readFile(`services/${serviceName}/Dockerfile`);

    assert.match(startupSource, /env\.PORT \?\? 8080/);
    assert.match(dockerfileSource, /EXPOSE 8080/);
  }
});

test('service Docker builds install dependencies from the committed lockfile', () => {
  for (const serviceName of expectedServices) {
    const dockerfileSource = readFile(`services/${serviceName}/Dockerfile`);

    assert.match(dockerfileSource, /COPY package-lock\.json \.\//);
    assert.match(dockerfileSource, /RUN npm ci\b/);
    assert.doesNotMatch(dockerfileSource, /RUN npm install\b/);
  }
});

test('docker compose defines infrastructure and all four services', () => {
  const composeSource = readFile('infra/docker-compose.yml');

  for (const serviceName of [
    'postgres',
    'redis',
    'rabbitmq',
    ...expectedServices,
  ]) {
    assert.match(composeSource, new RegExp(`\\n\\s{2}${serviceName}:`));
  }
});

test('docker compose publishes only api-gateway HTTP port to the host', () => {
  const composeSource = readFile('infra/docker-compose.yml');

  assert.match(composeSource, /api-gateway:[\s\S]*ports:[\s\S]*"8080:8080"/);

  for (const serviceName of ['payment-service', 'ledger-service', 'webhook-service']) {
    const serviceBlockPattern = new RegExp(`\\n\\s{2}${serviceName}:[\\s\\S]*?(?=\\n\\s{2}[a-z-]+:|\\n*$)`);
    const serviceBlock = composeSource.match(serviceBlockPattern)?.[0] ?? '';

    assert.doesNotMatch(serviceBlock, /\n\s+ports:/, `${serviceName} should not publish host ports`);
    assert.match(serviceBlock, /PORT: 8080/);
  }
});

test('docker compose internal service URLs use service discovery on port 8080', () => {
  const composeSource = readFile('infra/docker-compose.yml');

  assert.match(composeSource, /PAYMENT_SERVICE_BASE_URL: http:\/\/payment-service:8080/);
  assert.match(composeSource, /LEDGER_SERVICE_BASE_URL: http:\/\/ledger-service:8080/);
  assert.match(composeSource, /WEBHOOK_SERVICE_BASE_URL: http:\/\/webhook-service:8080/);
});

test('postgres init script creates one database per database-owning service', () => {
  const initSql = readFile('infra/postgres/init.sql');

  assert.match(initSql, /CREATE DATABASE payment_db;/);
  assert.match(initSql, /CREATE DATABASE ledger_db;/);
  assert.match(initSql, /CREATE DATABASE webhook_db;/);
});
