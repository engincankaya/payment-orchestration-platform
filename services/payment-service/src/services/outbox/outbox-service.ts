import { randomUUID } from 'crypto';

import type { PaymentRecord } from '../../data-access/payments/payments-data-access';
import type { TransactionContext } from '../../data-access/transaction-manager';

type PaymentEventType =
  | 'payment.authorized.v1'
  | 'payment.captured.v1'
  | 'payment.failed.v1';

export interface PaymentEventEnvelope {
  eventId: string;
  eventType: PaymentEventType;
  eventVersion: 1;
  source: 'payment-service';
  correlationId: string;
  occurredAt: string;
  aggregateType: 'payment';
  aggregateId: string;
  payload: Record<string, unknown>;
}

export interface InsertPendingOutboxEvent {
  id: string;
  aggregateType: 'payment';
  aggregateId: string;
  eventType: PaymentEventType;
  eventVersion: 1;
  routingKey: PaymentEventType;
  payload: PaymentEventEnvelope;
}

export interface OutboxEventsDataAccessPort {
  /** Inserts a pending event using the caller's transaction. */
  insertPending(
    event: InsertPendingOutboxEvent,
    trx: TransactionContext,
  ): Promise<unknown>;
}

export default class OutboxService {
  private readonly outboxEventsDataAccess: OutboxEventsDataAccessPort;

  constructor(deps: { outboxEventsDataAccess: OutboxEventsDataAccessPort }) {
    this.outboxEventsDataAccess = deps.outboxEventsDataAccess;
  }

  /** Records a payment-authorized event in the provided transaction. */
  public recordPaymentAuthorized = async (
    input: { correlationId: string; payment: PaymentRecord },
    trx: TransactionContext,
  ) => {
    return this.recordEvent(
      'payment.authorized.v1',
      input.correlationId,
      input.payment,
      {
        ...this.buildPaymentPayload(input.payment),
        providerPaymentId: this.requireNonEmptyString(
          input.payment.provider_payment_id,
          'providerPaymentId',
        ),
        authorizedAt: this.toIsoTimestamp(input.payment.authorized_at),
      },
      trx,
    );
  };

  /** Records a payment-captured event in the provided transaction. */
  public recordPaymentCaptured = async (
    input: { correlationId: string; payment: PaymentRecord },
    trx: TransactionContext,
  ) => {
    return this.recordEvent(
      'payment.captured.v1',
      input.correlationId,
      input.payment,
      {
        ...this.buildPaymentPayload(input.payment),
        providerPaymentId: this.requireNonEmptyString(
          input.payment.provider_payment_id,
          'providerPaymentId',
        ),
        capturedAt: this.toIsoTimestamp(input.payment.captured_at),
      },
      trx,
    );
  };

  /** Records a payment-failed event in the provided transaction. */
  public recordPaymentFailed = async (
    input: {
      correlationId: string;
      operation: 'AUTHORIZE' | 'CAPTURE';
      payment: PaymentRecord;
    },
    trx: TransactionContext,
  ) => {
    return this.recordEvent(
      'payment.failed.v1',
      input.correlationId,
      input.payment,
      {
        ...this.buildPaymentPayload(input.payment),
        providerPaymentId: input.payment.provider_payment_id ?? null,
        operation: input.operation,
        status: input.operation === 'AUTHORIZE' ? 'FAILED' : 'CAPTURE_FAILED',
        failureCode: this.requireNonEmptyString(
          input.payment.failure_code,
          'failureCode',
        ),
        failureMessage: this.requireNonEmptyString(
          input.payment.failure_message,
          'failureMessage',
        ),
        failedAt: this.toIsoTimestamp(input.payment.failed_at),
      },
      trx,
    );
  };

  private recordEvent = async (
    eventType: PaymentEventType,
    correlationId: string,
    payment: PaymentRecord,
    payload: Record<string, unknown>,
    trx: TransactionContext,
  ) => {
    const eventId = randomUUID();
    const envelope: PaymentEventEnvelope = {
      eventId,
      eventType,
      eventVersion: 1,
      source: 'payment-service',
      correlationId,
      occurredAt: new Date().toISOString(),
      aggregateType: 'payment',
      aggregateId: payment.id,
      payload,
    };

    return this.outboxEventsDataAccess.insertPending({
      id: eventId,
      aggregateType: 'payment',
      aggregateId: payment.id,
      eventType,
      eventVersion: 1,
      routingKey: eventType,
      payload: envelope,
    }, trx);
  };

  private buildPaymentPayload(payment: PaymentRecord) {
    return {
      paymentId: payment.id,
      merchantId: payment.merchant_id,
      amountMinor: Number(payment.amount_minor),
      currency: payment.currency,
      provider: payment.provider,
    };
  }

  private toIsoTimestamp(value: Date | string | null | undefined) {
    const timestamp = value instanceof Date ? value : new Date(value ?? '');
    return timestamp.toISOString();
  }

  private requireNonEmptyString(
    value: string | null | undefined,
    fieldName: string,
  ) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Cannot record outbox event without ${fieldName}`);
    }

    return value;
  }
}
