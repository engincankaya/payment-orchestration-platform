import type { ConfirmChannel, Message } from 'amqplib';

import type { OutboxEventRecord } from '../data-access/outbox/outbox-events-data-access';
import type RabbitMqConnectionManager from './rabbitmq-connection-manager';

const PAYMENTS_EXCHANGE = 'payments.events';
const DEFAULT_CONFIRM_TIMEOUT_MS = 10_000;

interface PaymentEventEnvelope {
  correlationId: string;
  eventType: string;
}

interface PendingPublish {
  channel: ConfirmChannel;
  returnedError: Error | null;
}

export class RabbitMqPublishNotAttemptedError extends Error {
  constructor(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(`RabbitMQ publish was not attempted: ${message}`);
    this.name = 'RabbitMqPublishNotAttemptedError';
  }
}

export default class RabbitMqPublisher {
  private readonly rabbitMqConnectionManager: RabbitMqConnectionManager;
  private readonly confirmTimeoutMs: number;
  private readonly pendingPublishes = new Map<string, PendingPublish>();

  constructor(deps: {
    env: NodeJS.ProcessEnv;
    rabbitMqConnectionManager: RabbitMqConnectionManager;
  }) {
    this.rabbitMqConnectionManager = deps.rabbitMqConnectionManager;
    this.confirmTimeoutMs = this.parsePositiveInteger(
      deps.env.RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS,
      'RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS',
      DEFAULT_CONFIRM_TIMEOUT_MS,
    );
    this.rabbitMqConnectionManager.onReturnedMessage(
      this.handleReturnedMessage,
    );
  }

  /** Publishes a stored outbox envelope and waits for its broker confirm. */
  public publish = async (event: OutboxEventRecord): Promise<void> => {
    let channel: ConfirmChannel;
    try {
      channel = await this.rabbitMqConnectionManager.getConfirmChannel();
    } catch (error) {
      throw new RabbitMqPublishNotAttemptedError(error);
    }
    const envelope = event.payload as unknown as PaymentEventEnvelope;
    const content = Buffer.from(JSON.stringify(event.payload));

    return new Promise<void>((resolve, reject) => {
      const pending: PendingPublish = {
        channel,
        returnedError: null,
      };
      this.pendingPublishes.set(event.id, pending);

      let settled = false;
      const settle = (error?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.pendingPublishes.delete(event.id);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const timeout = setTimeout(() => {
        const error = new Error(
          `RabbitMQ publish confirm timeout for message ${event.id}`,
        );
        void this.rabbitMqConnectionManager.invalidateChannel(channel);
        settle(error);
      }, this.confirmTimeoutMs);

      try {
        channel.publish(
          PAYMENTS_EXCHANGE,
          event.routing_key,
          content,
          {
            mandatory: true,
            persistent: true,
            contentType: 'application/json',
            messageId: event.id,
            correlationId: envelope.correlationId,
            type: event.event_type,
          },
          (error) => {
            settle(
              error
                ? this.toError(error)
                : pending.returnedError,
            );
          },
        );
      } catch (error) {
        settle(this.toError(error));
      }
    });
  };

  private handleReturnedMessage = (message: Message) => {
    const messageId = message.properties.messageId;
    if (typeof messageId !== 'string') {
      return;
    }

    const pending = this.pendingPublishes.get(messageId);
    if (!pending) {
      return;
    }

    const fields = message.fields as typeof message.fields & {
      replyText?: string;
    };
    pending.returnedError = new Error(
      `RabbitMQ publish returned ${fields.replyText || 'NO_ROUTE'} for message ${messageId}`,
    );
  };

  private toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }

  private parsePositiveInteger(
    value: string | undefined,
    name: string,
    defaultValue: number,
  ) {
    if (value === undefined) {
      return defaultValue;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive finite integer`);
    }
    return parsed;
  }
}
