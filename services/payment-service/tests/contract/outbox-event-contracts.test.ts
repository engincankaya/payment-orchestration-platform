import fs from 'fs';
import path from 'path';

import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import type { PaymentRecord } from '../../src/data-access/payments/payments-data-access';
import type { TransactionContext } from '../../src/data-access/transaction-manager';
import { AMOUNT_MINOR_MAX } from '../../src/server/routes/payments/payments';

type OutboxServiceConstructor =
  typeof import('../../src/services/outbox/outbox-service').default;

type SchemaName = 'authorized' | 'captured' | 'failed';
type EventEnvelope = {
  eventId: string;
  eventType: string;
  eventVersion: number;
  source: string;
  correlationId: string;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

const schemaDirectory = path.resolve(__dirname, '../../../../docs/contracts/events');
const outboxServiceModulePath = '../../src/services/outbox/outbox-service';
const paymentId = '11111111-1111-4111-8111-111111111111';
const merchantId = '22222222-2222-4222-8222-222222222222';
const trx = { id: 'contract-trx' } as unknown as TransactionContext;

const schemaFiles: Record<SchemaName, string> = {
  authorized: 'payment-authorized.v1.schema.json',
  captured: 'payment-captured.v1.schema.json',
  failed: 'payment-failed.v1.schema.json',
};

const eventTypes: Record<SchemaName, string> = {
  authorized: 'payment.authorized.v1',
  captured: 'payment.captured.v1',
  failed: 'payment.failed.v1',
};

function compileSchema(name: SchemaName): ValidateFunction {
  const schema = JSON.parse(
    fs.readFileSync(path.join(schemaDirectory, schemaFiles[name]), 'utf8'),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function buildEnvelope(
  name: SchemaName,
  payload: Record<string, unknown>,
  correlationId = 'client-trace-01HXYZ',
): EventEnvelope {
  return {
    eventId: '33333333-3333-4333-8333-333333333333',
    eventType: eventTypes[name],
    eventVersion: 1,
    source: 'payment-service',
    correlationId,
    occurredAt: '2026-07-23T11:00:00.000Z',
    aggregateType: 'payment',
    aggregateId: paymentId,
    payload,
  };
}

const authorizedEvent = buildEnvelope('authorized', {
  paymentId,
  merchantId,
  amountMinor: 1000,
  currency: 'TRY',
  provider: 'mock-provider',
  providerPaymentId: 'provider-payment-1',
  authorizedAt: '2026-07-23T10:00:00.000Z',
});

const capturedEvent = buildEnvelope('captured', {
  paymentId,
  merchantId,
  amountMinor: 1000,
  currency: 'TRY',
  provider: 'mock-provider',
  providerPaymentId: 'provider-payment-1',
  capturedAt: '2026-07-23T11:00:00.000Z',
});

const authorizeFailedEvent = buildEnvelope('failed', {
  paymentId,
  merchantId,
  amountMinor: 9999,
  currency: 'TRY',
  provider: 'mock-provider',
  providerPaymentId: null,
  operation: 'AUTHORIZE',
  status: 'FAILED',
  failureCode: 'MOCK_AUTHORIZATION_FAILED',
  failureMessage: 'Mock authorization failure',
  failedAt: '2026-07-23T10:00:00.000Z',
});

const captureFailedEvent = buildEnvelope('failed', {
  paymentId,
  merchantId,
  amountMinor: 1000,
  currency: 'TRY',
  provider: 'mock-provider',
  providerPaymentId: 'provider-payment-1',
  operation: 'CAPTURE',
  status: 'CAPTURE_FAILED',
  failureCode: 'MOCK_CAPTURE_FAILED',
  failureMessage: 'Mock capture failure',
  failedAt: '2026-07-23T11:00:00.000Z',
});

const canonicalEvents: Record<SchemaName, EventEnvelope> = {
  authorized: authorizedEvent,
  captured: capturedEvent,
  failed: authorizeFailedEvent,
};

const requiredEnvelopeFields = [
  'eventId',
  'eventType',
  'eventVersion',
  'source',
  'correlationId',
  'occurredAt',
  'aggregateType',
  'aggregateId',
  'payload',
] as const;

const requiredPayloadFields: Record<SchemaName, readonly string[]> = {
  authorized: [
    'paymentId',
    'merchantId',
    'amountMinor',
    'currency',
    'provider',
    'providerPaymentId',
    'authorizedAt',
  ],
  captured: [
    'paymentId',
    'merchantId',
    'amountMinor',
    'currency',
    'provider',
    'providerPaymentId',
    'capturedAt',
  ],
  failed: [
    'paymentId',
    'merchantId',
    'amountMinor',
    'currency',
    'provider',
    'providerPaymentId',
    'operation',
    'status',
    'failureCode',
    'failureMessage',
    'failedAt',
  ],
};

function mutate(
  event: EventEnvelope,
  change: (copy: EventEnvelope) => void,
): EventEnvelope {
  const copy = structuredClone(event);
  change(copy);
  return copy;
}

function expectValid(validate: ValidateFunction, event: EventEnvelope) {
  const valid = validate(event);
  expect({ valid, errors: validate.errors }).toEqual({ valid: true, errors: null });
}

function expectAllInvalid(
  validate: ValidateFunction,
  cases: Array<{ name: string; event: EventEnvelope }>,
) {
  const unexpectedlyValid = cases
    .filter(({ event }) => validate(event))
    .map(({ name }) => name);
  expect(unexpectedlyValid).toEqual([]);
}

const paymentRecords: Record<SchemaName, PaymentRecord> = {
  authorized: {
    id: paymentId,
    merchant_id: merchantId,
    amount_minor: '1000',
    currency: 'TRY',
    status: 'AUTHORIZED',
    provider: 'mock-provider',
    provider_payment_id: 'provider-payment-1',
    failure_code: null,
    failure_message: null,
    authorized_at: '2026-07-23T10:00:00.000Z',
    captured_at: null,
    failed_at: null,
    created_at: '2026-07-23T09:00:00.000Z',
    updated_at: '2026-07-23T10:00:00.000Z',
  },
  captured: {
    id: paymentId,
    merchant_id: merchantId,
    amount_minor: '1000',
    currency: 'TRY',
    status: 'CAPTURED',
    provider: 'mock-provider',
    provider_payment_id: 'provider-payment-1',
    failure_code: null,
    failure_message: null,
    authorized_at: '2026-07-23T10:00:00.000Z',
    captured_at: '2026-07-23T11:00:00.000Z',
    failed_at: null,
    created_at: '2026-07-23T09:00:00.000Z',
    updated_at: '2026-07-23T11:00:00.000Z',
  },
  failed: {
    id: paymentId,
    merchant_id: merchantId,
    amount_minor: '9999',
    currency: 'TRY',
    status: 'FAILED',
    provider: 'mock-provider',
    provider_payment_id: null,
    failure_code: 'MOCK_AUTHORIZATION_FAILED',
    failure_message: 'Mock authorization failure',
    authorized_at: null,
    captured_at: null,
    failed_at: '2026-07-23T10:00:00.000Z',
    created_at: '2026-07-23T09:00:00.000Z',
    updated_at: '2026-07-23T10:00:00.000Z',
  },
};

async function buildEnvelopeWithOutboxService(name: SchemaName) {
  const insertPending = jest.fn().mockImplementation(async (record) => record);
  const { default: OutboxService } = require(outboxServiceModulePath) as {
    default: OutboxServiceConstructor;
  };
  const service = new OutboxService({
    outboxEventsDataAccess: { insertPending },
  });
  const payment = paymentRecords[name];

  if (name === 'authorized') {
    await service.recordPaymentAuthorized({ correlationId: 'client-trace-01HXYZ', payment }, trx);
  } else if (name === 'captured') {
    await service.recordPaymentCaptured({ correlationId: 'client-trace-01HXYZ', payment }, trx);
  } else {
    await service.recordPaymentFailed({
      correlationId: 'client-trace-01HXYZ',
      operation: 'AUTHORIZE',
      payment,
    }, trx);
  }

  return insertPending.mock.calls[0][0].payload as EventEnvelope;
}

describe('payment event JSON Schema contracts', () => {
  it.each(Object.keys(schemaFiles) as SchemaName[])(
    'compiles the %s event schema with format validation',
    (name) => {
      expect(compileSchema(name)).toEqual(expect.any(Function));
    },
  );

  it.each([
    ['authorized', authorizedEvent],
    ['captured', capturedEvent],
    ['failed', authorizeFailedEvent],
  ] as const)('accepts the canonical %s event', (name, event) => {
    expectValid(compileSchema(name), event);
  });

  it.each(Object.keys(canonicalEvents) as SchemaName[])(
    'requires every envelope field in the %s schema',
    (name) => {
      const cases = requiredEnvelopeFields.map((field) => ({
        name: `missing ${field}`,
        event: mutate(canonicalEvents[name], (copy) => {
          delete (copy as unknown as Record<string, unknown>)[field];
        }),
      }));

      expectAllInvalid(compileSchema(name), cases);
    },
  );

  it.each(Object.keys(canonicalEvents) as SchemaName[])(
    'requires every payload field in the %s schema',
    (name) => {
      const cases = requiredPayloadFields[name].map((field) => ({
        name: `missing payload.${field}`,
        event: mutate(canonicalEvents[name], (copy) => {
          delete copy.payload[field];
        }),
      }));

      expectAllInvalid(compileSchema(name), cases);
    },
  );

  it.each(Object.keys(canonicalEvents) as SchemaName[])(
    'accepts TRY, USD, and EUR in the %s schema',
    (name) => {
      const validate = compileSchema(name);

      for (const currency of ['TRY', 'USD', 'EUR']) {
        expectValid(validate, mutate(canonicalEvents[name], (copy) => {
          copy.payload.currency = currency;
        }));
      }
    },
  );

  it.each(Object.keys(canonicalEvents) as SchemaName[])(
    'rejects invalid shared envelope and payload fields in the %s schema',
    (name) => {
      const event = canonicalEvents[name];
      const cases = [
        {
          name: 'missing merchantId',
          event: mutate(event, (copy) => delete copy.payload.merchantId),
        },
        {
          name: 'invalid eventId',
          event: mutate(event, (copy) => {
            copy.eventId = 'not-a-uuid';
          }),
        },
        {
          name: 'invalid occurredAt',
          event: mutate(event, (copy) => {
            copy.occurredAt = 'not-a-timestamp';
          }),
        },
        {
          name: 'wrong eventType',
          event: mutate(event, (copy) => {
            copy.eventType = 'payment.unknown.v1';
          }),
        },
        {
          name: 'wrong eventVersion',
          event: mutate(event, (copy) => {
            copy.eventVersion = 2;
          }),
        },
        {
          name: 'wrong source',
          event: mutate(event, (copy) => {
            copy.source = 'another-service';
          }),
        },
        {
          name: 'wrong aggregateType',
          event: mutate(event, (copy) => {
            copy.aggregateType = 'merchant';
          }),
        },
        {
          name: 'invalid aggregateId',
          event: mutate(event, (copy) => {
            copy.aggregateId = 'not-a-uuid';
          }),
        },
        {
          name: 'invalid paymentId',
          event: mutate(event, (copy) => {
            copy.payload.paymentId = 'not-a-uuid';
          }),
        },
        {
          name: 'invalid merchantId',
          event: mutate(event, (copy) => {
            copy.payload.merchantId = 'not-a-uuid';
          }),
        },
        {
          name: 'zero amountMinor',
          event: mutate(event, (copy) => {
            copy.payload.amountMinor = 0;
          }),
        },
        {
          name: 'negative amountMinor',
          event: mutate(event, (copy) => {
            copy.payload.amountMinor = -1;
          }),
        },
        {
          name: 'decimal amountMinor',
          event: mutate(event, (copy) => {
            copy.payload.amountMinor = 10.5;
          }),
        },
        {
          name: 'amountMinor over maximum',
          event: mutate(event, (copy) => {
            copy.payload.amountMinor = AMOUNT_MINOR_MAX + 1;
          }),
        },
        {
          name: 'invalid currency',
          event: mutate(event, (copy) => {
            copy.payload.currency = 'GBP';
          }),
        },
      ];

      expectAllInvalid(compileSchema(name), cases);
    },
  );

  it('rejects invalid authorized-specific payload fields', () => {
    const cases = [
      {
        name: 'missing authorizedAt',
        event: mutate(authorizedEvent, (event) => delete event.payload.authorizedAt),
      },
      {
        name: 'invalid authorizedAt',
        event: mutate(authorizedEvent, (event) => {
          event.payload.authorizedAt = 'not-a-timestamp';
        }),
      },
      {
        name: 'null providerPaymentId',
        event: mutate(authorizedEvent, (event) => {
          event.payload.providerPaymentId = null;
        }),
      },
    ];

    expectAllInvalid(compileSchema('authorized'), cases);
  });

  it('rejects invalid captured payloads', () => {
    const cases = [
      {
        name: 'missing capturedAt',
        event: mutate(capturedEvent, (event) => delete event.payload.capturedAt),
      },
      {
        name: 'invalid capturedAt',
        event: mutate(capturedEvent, (event) => {
          event.payload.capturedAt = 'not-a-timestamp';
        }),
      },
      {
        name: 'null providerPaymentId',
        event: mutate(capturedEvent, (event) => {
          event.payload.providerPaymentId = null;
        }),
      },
    ];

    expectAllInvalid(compileSchema('captured'), cases);
  });

  it('enforces failed-event operation and status pairs', () => {
    const validate = compileSchema('failed');
    expectValid(validate, authorizeFailedEvent);
    expectValid(validate, captureFailedEvent);

    const invalidCases = [
      {
        name: 'missing operation',
        event: mutate(authorizeFailedEvent, (event) => delete event.payload.operation),
      },
      {
        name: 'unknown operation',
        event: mutate(authorizeFailedEvent, (event) => {
          event.payload.operation = 'REFUND';
        }),
      },
      {
        name: 'AUTHORIZE with CAPTURE_FAILED',
        event: mutate(authorizeFailedEvent, (event) => {
          event.payload.status = 'CAPTURE_FAILED';
        }),
      },
      {
        name: 'CAPTURE with FAILED',
        event: mutate(captureFailedEvent, (event) => {
          event.payload.status = 'FAILED';
        }),
      },
      {
        name: 'invalid failedAt',
        event: mutate(authorizeFailedEvent, (event) => {
          event.payload.failedAt = 'not-a-timestamp';
        }),
      },
      {
        name: 'missing failedAt',
        event: mutate(authorizeFailedEvent, (event) => delete event.payload.failedAt),
      },
    ];

    expectAllInvalid(validate, invalidCases);
  });

  it('allows nullable failed provider references and additive payload fields', () => {
    const failedValidator = compileSchema('failed');
    expectValid(failedValidator, authorizeFailedEvent);

    const additiveEvent = mutate(authorizedEvent, (event) => {
      event.payload.amountMinor = AMOUNT_MINOR_MAX;
      event.payload.futureOptionalField = 'supported';
    });
    expectValid(compileSchema('authorized'), additiveEvent);
  });

  it.each(Object.keys(canonicalEvents) as SchemaName[])(
    'enforces the bounded printable-ASCII correlation contract for %s events',
    (name) => {
      const validate = compileSchema(name);
      const event = canonicalEvents[name];
      expectValid(validate, mutate(event, (copy) => {
        copy.correlationId = 'x';
      }));
      expectValid(validate, mutate(event, (copy) => {
        copy.correlationId = 'x'.repeat(128);
      }));

      const invalidCases = [
        {
          name: 'empty',
          event: mutate(event, (copy) => {
            copy.correlationId = '';
          }),
        },
        {
          name: 'whitespace',
          event: mutate(event, (copy) => {
            copy.correlationId = '   ';
          }),
        },
        {
          name: 'too long',
          event: mutate(event, (copy) => {
            copy.correlationId = 'x'.repeat(129);
          }),
        },
        {
          name: 'control character',
          event: mutate(event, (copy) => {
            copy.correlationId = 'trace\nid';
          }),
        },
      ];
      expectAllInvalid(validate, invalidCases);
    },
  );

  it.each(Object.keys(schemaFiles) as SchemaName[])(
    'validates the %s envelope produced by OutboxService',
    async (name) => {
      const envelope = await buildEnvelopeWithOutboxService(name);
      expectValid(compileSchema(name), envelope);
    },
  );
});
