import { EventEmitter } from 'node:events';

import RabbitMqPublisher, {
  RabbitMqPublishNotAttemptedError,
} from '../../src/messaging/rabbitmq-publisher';
import type { OutboxEventRecord } from '../../src/data-access/outbox/outbox-events-data-access';

const eventId = '11111111-1111-4111-8111-111111111111';
const envelope = {
  eventId,
  eventType: 'payment.captured.v1',
  eventVersion: 1,
  occurredAt: '2026-07-26T10:00:00.000Z',
  correlationId: 'capture-correlation',
  source: 'payment-service',
  aggregateType: 'payment',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  payload: {
    paymentId: '22222222-2222-4222-8222-222222222222',
    merchantId: '33333333-3333-4333-8333-333333333333',
    amountMinor: 1000,
    currency: 'TRY',
    provider: 'mock-provider',
    providerPaymentId: 'mock-payment-1',
    capturedAt: '2026-07-26T10:00:00.000Z',
  },
};

function buildEvent(): OutboxEventRecord {
  return {
    id: eventId,
    aggregate_type: 'payment',
    aggregate_id: envelope.payload.paymentId,
    event_type: envelope.eventType,
    event_version: 1,
    routing_key: envelope.eventType,
    payload: envelope,
    status: 'PENDING',
    attempts: 0,
    next_retry_at: null,
    last_error: null,
    created_at: new Date('2026-07-26T10:00:00.000Z'),
    published_at: null,
  };
}

class FakeConfirmChannel extends EventEmitter {
  public publish = jest.fn();
  public close = jest.fn().mockResolvedValue(undefined);
}

function createSubject(
  env: NodeJS.ProcessEnv = {},
  publishImplementation?: (...args: unknown[]) => boolean,
) {
  const channel = new FakeConfirmChannel();
  channel.publish.mockImplementation(publishImplementation ?? ((
    _exchange: unknown,
    _routingKey: unknown,
    _content: unknown,
    _options: unknown,
    callback: (error: Error | null) => void,
  ) => {
    callback(null);
    return true;
  }));
  const rabbitMqConnectionManager = {
    getConfirmChannel: jest.fn().mockResolvedValue(channel),
    invalidateChannel: jest.fn().mockResolvedValue(undefined),
    onReturnedMessage: jest.fn().mockImplementation((handler) => {
      channel.on('return', handler);
      return () => channel.removeListener('return', handler);
    }),
  };
  const subject = new RabbitMqPublisher({
    env,
    rabbitMqConnectionManager,
  } as never);

  return { subject, channel, rabbitMqConnectionManager };
}

describe('RabbitMqPublisher', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['0'],
    ['-1'],
    ['1.5'],
    ['NaN'],
    ['Infinity'],
  ])('rejects an invalid confirm timeout (%s)', (value) => {
    expect(() => createSubject({
      RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS: value,
    })).toThrow(/RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS/);
  });

  it('publishes the stored envelope with mandatory persistent AMQP properties and waits for confirm', async () => {
    let confirm: ((error: Error | null) => void) | undefined;
    const { subject, channel } = createSubject({}, (
      _exchange,
      _routingKey,
      _content,
      _options,
      callback,
    ) => {
      confirm = callback as (error: Error | null) => void;
      return true;
    });

    const publishing = subject.publish(buildEvent());
    await Promise.resolve();
    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [exchange, routingKey, content, options] = channel.publish.mock.calls[0];
    expect(exchange).toBe('payments.events');
    expect(routingKey).toBe('payment.captured.v1');
    expect(JSON.parse((content as Buffer).toString('utf8'))).toEqual(envelope);
    expect(options).toMatchObject({
      mandatory: true,
      persistent: true,
      contentType: 'application/json',
      messageId: eventId,
      correlationId: envelope.correlationId,
      type: envelope.eventType,
    });

    let settled = false;
    void publishing.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    confirm?.(null);
    await expect(publishing).resolves.toBeUndefined();
  });

  it('identifies a channel acquisition failure as a publish that was not attempted', async () => {
    const { subject, channel, rabbitMqConnectionManager } = createSubject();
    rabbitMqConnectionManager.getConfirmChannel.mockRejectedValue(
      new Error('reconnect failed'),
    );

    await expect(subject.publish(buildEvent())).rejects.toBeInstanceOf(
      RabbitMqPublishNotAttemptedError,
    );
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('treats a returned mandatory message as failure even when broker confirm succeeds', async () => {
    const { subject, channel } = createSubject({}, (
      _exchange,
      routingKey,
      content,
      options,
      callback,
    ) => {
      channel.emit('return', {
        fields: { replyCode: 312, replyText: 'NO_ROUTE', routingKey },
        properties: options,
        content,
      });
      (callback as (error: Error | null) => void)(null);
      return true;
    });

    await expect(subject.publish(buildEvent())).rejects.toThrow(/NO_ROUTE/);
  });

  it('correlates returned messages by messageId when publishes are in flight together', async () => {
    const confirms = new Map<string, (error: Error | null) => void>();
    const { subject, channel } = createSubject({}, (
      _exchange,
      _routingKey,
      _content,
      options,
      callback,
    ) => {
      const messageId = (options as { messageId: string }).messageId;
      confirms.set(messageId, callback as (error: Error | null) => void);
      return true;
    });
    const secondId = '22222222-2222-4222-8222-222222222222';
    const secondEvent = {
      ...buildEvent(),
      id: secondId,
      payload: {
        ...envelope,
        eventId: secondId,
      },
    };

    const firstPublish = subject.publish(buildEvent());
    const secondPublish = subject.publish(secondEvent);
    const firstResult = expect(firstPublish).resolves.toBeUndefined();
    const secondResult = expect(secondPublish).rejects.toThrow(/NO_ROUTE/);
    await Promise.resolve();

    channel.emit('return', {
      fields: {
        replyCode: 312,
        replyText: 'NO_ROUTE',
        routingKey: secondEvent.routing_key,
      },
      properties: { messageId: secondId },
      content: Buffer.from(JSON.stringify(secondEvent.payload)),
    });
    confirms.get(eventId)?.(null);
    confirms.get(secondId)?.(null);

    await Promise.all([firstResult, secondResult]);
  });

  it('times out an ambiguous confirm after the default 10000 ms and invalidates the channel', async () => {
    jest.useFakeTimers();
    const { subject, channel, rabbitMqConnectionManager } = createSubject(
      {},
      () => true,
    );

    const publishing = subject.publish(buildEvent());
    const rejected = expect(publishing).rejects.toThrow(/confirm.*timeout/i);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(9_999);
    expect(rabbitMqConnectionManager.invalidateChannel).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);

    await rejected;
    expect(rabbitMqConnectionManager.invalidateChannel).toHaveBeenCalledWith(channel);
  });

  it('uses the configured confirm timeout and permits a later publish on a fresh channel', async () => {
    jest.useFakeTimers();
    const { subject, channel, rabbitMqConnectionManager } = createSubject(
      { RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS: '25' },
      () => true,
    );
    const replacementChannel = new FakeConfirmChannel();
    replacementChannel.publish.mockImplementation((
      _exchange,
      _routingKey,
      _content,
      _options,
      callback,
    ) => {
      callback(null);
      return true;
    });
    rabbitMqConnectionManager.getConfirmChannel
      .mockResolvedValueOnce(channel)
      .mockResolvedValueOnce(replacementChannel);

    const first = subject.publish(buildEvent());
    const firstRejected = expect(first).rejects.toThrow(/confirm.*timeout/i);
    await jest.advanceTimersByTimeAsync(25);
    await firstRejected;

    await expect(subject.publish(buildEvent())).resolves.toBeUndefined();
    expect(replacementChannel.publish).toHaveBeenCalledTimes(1);
  });
});
