const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..', '..');
const paymentServiceDir = path.join(rootDir, 'services', 'payment-service');
const paymentServiceSourceDir = path.join(paymentServiceDir, 'src');
const ts = require(require.resolve('typescript', { paths: [paymentServiceDir] }));

function pathExists(relativePath) {
  return fs.existsSync(path.join(rootDir, relativePath));
}

function walkTypeScriptFiles(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        return walkTypeScriptFiles(entryPath);
      }

      return entry.name.endsWith('.ts') ? [entryPath] : [];
    });
}

function extractModuleSpecifiers(source, fileName = 'architecture-fixture.ts') {
  const specifiers = [];
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function addStringLiteral(node) {
    if (node && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addStringLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';

      if (isDynamicImport || isRequire) {
        addStringLiteral(node.arguments[0]);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addStringLiteral(node.argument.literal);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return [...new Set(specifiers)];
}

function readModuleSpecifiers(filePath) {
  return extractModuleSpecifiers(fs.readFileSync(filePath, 'utf8'), filePath);
}

function extractCalledMemberNames(source, fileName) {
  const memberNames = [];
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        memberNames.push(node.expression.name.text);
      } else if (
        ts.isElementAccessExpression(node.expression) &&
        ts.isStringLiteralLike(node.expression.argumentExpression)
      ) {
        memberNames.push(node.expression.argumentExpression.text);
      } else if (ts.isIdentifier(node.expression)) {
        memberNames.push(node.expression.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return memberNames;
}

function isWithin(candidatePath, directoryPath) {
  const relativePath = path.relative(directoryPath, candidatePath);

  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolvesWithin(sourceFile, importSpecifier, targetDirectory) {
  if (!importSpecifier.startsWith('.')) {
    return false;
  }

  return isWithin(path.resolve(path.dirname(sourceFile), importSpecifier), targetDirectory);
}

function relativeToRoot(filePath) {
  return path.relative(rootDir, filePath);
}

test('characterization: Phase 4 capture and outbox production files exist', () => {
  const expectedFiles = [
    'services/payment-service/src/messaging/rabbitmq-connection-manager.ts',
    'services/payment-service/src/messaging/rabbitmq-publisher.ts',
    'services/payment-service/src/workers/outbox-publisher-worker.ts',
    'services/payment-service/src/services/outbox/outbox-service.ts',
    'services/payment-service/src/data-access/outbox/outbox-events-data-access.ts',
    'services/payment-service/src/bootstrap/payment-service-bootstrap.ts',
    'services/payment-service/src/bootstrap/knex/migrations/005_add_idempotency_processing_token.ts',
    'services/payment-service/src/bootstrap/knex/migrations/006_create_outbox_events.ts',
  ];

  const missingFiles = expectedFiles.filter((filePath) => !pathExists(filePath));

  assert.deepEqual(missingFiles, []);
});

test('characterization: Phase 4 event schemas exist', () => {
  const expectedSchemas = [
    'docs/contracts/events/payment-authorized.v1.schema.json',
    'docs/contracts/events/payment-captured.v1.schema.json',
    'docs/contracts/events/payment-failed.v1.schema.json',
  ];

  const missingSchemas = expectedSchemas.filter((filePath) => !pathExists(filePath));

  assert.deepEqual(missingSchemas, []);
});

test('test support: module extraction covers TypeScript dependency forms', () => {
  const cases = [
    ["import client from 'static-default';", ['static-default']],
    ["import type { Client } from 'static-type';", ['static-type']],
    ["import 'side-effect';", ['side-effect']],
    ["const client = require('commonjs');", ['commonjs']],
    ["import client = require('import-equals');", ['import-equals']],
    ["const client = await import('dynamic');", ['dynamic']],
    ["type Client = typeof import('type-query');", ['type-query']],
    ["export { client } from 'named-re-export';", ['named-re-export']],
    ["export * from 'star-re-export';", ['star-re-export']],
    [
      "// import client from 'comment';\nconst message = \"require('string-literal')\";",
      [],
    ],
  ];

  for (const [source, expected] of cases) {
    assert.deepEqual(extractModuleSpecifiers(source), expected, source);
  }
});

test('payment-service keeps direct amqplib imports inside the messaging layer', () => {
  const violations = walkTypeScriptFiles(paymentServiceSourceDir)
    .filter((filePath) =>
      readModuleSpecifiers(filePath).some(
        (specifier) => specifier === 'amqplib' || specifier.startsWith('amqplib/'),
      ),
    )
    .filter((filePath) => !isWithin(filePath, path.join(paymentServiceSourceDir, 'messaging')))
    .map(relativeToRoot);

  assert.deepEqual(violations, []);
});

test('characterization: API Gateway and Webhook Service do not publish payment events', () => {
  const serviceNames = ['api-gateway', 'webhook-service'];
  const forbiddenPublishingCalls = new Set([
    'createConfirmChannel',
    'publish',
    'sendToQueue',
  ]);
  const violations = [];

  for (const serviceName of serviceNames) {
    const serviceDir = path.join(rootDir, 'services', serviceName);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(serviceDir, 'package.json'), 'utf8'),
    );
    const dependencyNames = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ];

    if (dependencyNames.some((dependency) => dependency === 'amqplib')) {
      violations.push(`${serviceName}/package.json depends on amqplib`);
    }

    for (const sourceFile of walkTypeScriptFiles(path.join(serviceDir, 'src'))) {
      const source = fs.readFileSync(sourceFile, 'utf8');
      const importsAmqplib = readModuleSpecifiers(sourceFile).some(
        (specifier) => specifier === 'amqplib' || specifier.startsWith('amqplib/'),
      );
      const publishingCalls = extractCalledMemberNames(source, sourceFile).filter(
        (memberName) => forbiddenPublishingCalls.has(memberName),
      );

      if (importsAmqplib) {
        violations.push(`${relativeToRoot(sourceFile)} imports amqplib`);
      }

      if (publishingCalls.length > 0) {
        violations.push(
          `${relativeToRoot(sourceFile)} calls ${[...new Set(publishingCalls)].join(', ')}`,
        );
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('characterization: payment controllers do not import persistence or messaging', () => {
  const controllersDir = path.join(paymentServiceSourceDir, 'server', 'controllers');
  const dataAccessDir = path.join(paymentServiceSourceDir, 'data-access');
  const messagingDir = path.join(paymentServiceSourceDir, 'messaging');
  const violations = [];

  for (const sourceFile of walkTypeScriptFiles(controllersDir)) {
    for (const specifier of readModuleSpecifiers(sourceFile)) {
      if (
        specifier === 'amqplib' ||
        specifier.startsWith('amqplib/') ||
        resolvesWithin(sourceFile, specifier, dataAccessDir) ||
        resolvesWithin(sourceFile, specifier, messagingDir)
      ) {
        violations.push(`${relativeToRoot(sourceFile)} imports ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('characterization: payment services do not import the messaging layer', () => {
  const servicesDir = path.join(paymentServiceSourceDir, 'services');
  const messagingDir = path.join(paymentServiceSourceDir, 'messaging');
  const violations = [];

  for (const sourceFile of walkTypeScriptFiles(servicesDir)) {
    for (const specifier of readModuleSpecifiers(sourceFile)) {
      if (
        specifier === 'amqplib' ||
        specifier.startsWith('amqplib/') ||
        resolvesWithin(sourceFile, specifier, messagingDir)
      ) {
        violations.push(`${relativeToRoot(sourceFile)} imports ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('characterization: only workers and composition roots import payment messaging', () => {
  const messagingDir = path.join(paymentServiceSourceDir, 'messaging');
  const allowedImporters = [
    messagingDir,
    path.join(paymentServiceSourceDir, 'workers'),
    path.join(paymentServiceSourceDir, 'bootstrap'),
  ];
  const indexPath = path.join(paymentServiceSourceDir, 'index.ts');
  const violations = [];

  for (const sourceFile of walkTypeScriptFiles(paymentServiceSourceDir)) {
    const importsMessaging = readModuleSpecifiers(sourceFile).some((specifier) =>
      resolvesWithin(sourceFile, specifier, messagingDir),
    );
    const isAllowed =
      sourceFile === indexPath ||
      allowedImporters.some((directoryPath) => isWithin(sourceFile, directoryPath));

    if (importsMessaging && !isAllowed) {
      violations.push(relativeToRoot(sourceFile));
    }
  }

  assert.deepEqual(violations, []);
});

test('characterization: payment data-access does not import higher layers or messaging', () => {
  const dataAccessDir = path.join(paymentServiceSourceDir, 'data-access');
  const servicesDir = path.join(paymentServiceSourceDir, 'services');
  const controllersDir = path.join(paymentServiceSourceDir, 'server', 'controllers');
  const messagingDir = path.join(paymentServiceSourceDir, 'messaging');
  const violations = [];

  for (const sourceFile of walkTypeScriptFiles(dataAccessDir)) {
    for (const specifier of readModuleSpecifiers(sourceFile)) {
      if (
        specifier === 'amqplib' ||
        specifier.startsWith('amqplib/') ||
        resolvesWithin(sourceFile, specifier, servicesDir) ||
        resolvesWithin(sourceFile, specifier, controllersDir) ||
        resolvesWithin(sourceFile, specifier, messagingDir)
      ) {
        violations.push(`${relativeToRoot(sourceFile)} imports ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
