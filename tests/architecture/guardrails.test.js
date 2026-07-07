const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..', '..');
const servicesDir = path.join(rootDir, 'services');

const allowedServices = new Set([
  'api-gateway',
  'payment-service',
  'ledger-service',
  'webhook-service',
]);

const forbiddenRootRuntimeDirs = ['packages', 'shared', 'common'];
const forbiddenDependencies = [
  '@nestjs/common',
  '@nestjs/core',
  '@prisma/client',
  'nestjs',
  'next',
  'prisma',
  'react',
  'react-dom',
  'vue',
];

function pathExists(filePath) {
  return fs.existsSync(filePath);
}

function listDirectories(directoryPath) {
  if (!pathExists(directoryPath)) {
    return [];
  }

  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function walkFiles(directoryPath, predicate = () => true) {
  if (!pathExists(directoryPath)) {
    return [];
  }

  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
        continue;
      }

      files.push(...walkFiles(entryPath, predicate));
      continue;
    }

    if (predicate(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('root does not contain shared runtime package directories', () => {
  const existingForbiddenDirs = forbiddenRootRuntimeDirs.filter((directoryName) =>
    pathExists(path.join(rootDir, directoryName)),
  );

  assert.deepEqual(existingForbiddenDirs, []);
});

test('services directory contains only the approved service boundaries when present', () => {
  const serviceNames = listDirectories(servicesDir);
  const unexpectedServices = serviceNames.filter((serviceName) => !allowedServices.has(serviceName));

  assert.deepEqual(unexpectedServices, []);
});

test('root package is orchestration-only and does not expose runtime dependencies', () => {
  const packageJson = readJson(path.join(rootDir, 'package.json'));

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.main, undefined);
  assert.equal(packageJson.exports, undefined);
  assert.equal(packageJson.workspaces, undefined);
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(packageJson.devDependencies ?? {}, {});
});

test('project package manifests do not use forbidden frameworks or frontend libraries', () => {
  const packageFiles = walkFiles(rootDir, (filePath) => path.basename(filePath) === 'package.json');
  const violations = [];

  for (const packageFile of packageFiles) {
    const packageJson = readJson(packageFile);
    const dependencyBlocks = [
      packageJson.dependencies ?? {},
      packageJson.devDependencies ?? {},
      packageJson.peerDependencies ?? {},
      packageJson.optionalDependencies ?? {},
    ];

    for (const dependencies of dependencyBlocks) {
      for (const dependencyName of Object.keys(dependencies)) {
        if (forbiddenDependencies.includes(dependencyName)) {
          violations.push(`${path.relative(rootDir, packageFile)} -> ${dependencyName}`);
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('service source files do not import another service internal runtime code', () => {
  const serviceNames = listDirectories(servicesDir).filter((serviceName) =>
    allowedServices.has(serviceName),
  );
  const violations = [];

  for (const serviceName of serviceNames) {
    const serviceSourceDir = path.join(servicesDir, serviceName, 'src');
    const sourceFiles = walkFiles(serviceSourceDir, (filePath) => /\.(cjs|mjs|js|ts)$/.test(filePath));
    const otherServices = serviceNames.filter((candidate) => candidate !== serviceName);

    for (const sourceFile of sourceFiles) {
      const source = fs.readFileSync(sourceFile, 'utf8');

      for (const otherService of otherServices) {
        const forbiddenPatterns = [
          `services/${otherService}/src`,
          `services/${otherService}`,
          `../${otherService}/src`,
          `../${otherService}`,
        ];

        if (forbiddenPatterns.some((pattern) => source.includes(pattern))) {
          violations.push(`${path.relative(rootDir, sourceFile)} imports ${otherService}`);
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});
