import type OutboxEventsDataAccess from '../../src/data-access/outbox/outbox-events-data-access';
import type {
  OutboxEventRecord,
} from '../../src/data-access/outbox/outbox-events-data-access';
import type { TransactionContext } from '../../src/data-access/transaction-manager';
import { RabbitMqPublishNotAttemptedError } from '../../src/messaging/rabbitmq-publisher';
import OutboxPublisherWorker from '../../src/workers/outbox-publisher-worker';

type OutboxEventsDataAccessPort = Pick<
  OutboxEventsDataAccess,
  'fetchPendingBatch' | 'markPublished' | 'markPublishFailed'
>;

const transaction = {
  id: 'worker-transaction',
} as unknown as TransactionContext;
const now = new Date('2026-07-26T12:00:00.000Z');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buildEvent(
  id: string,
  overrides: Partial<OutboxEventRecord> = {},
): OutboxEventRecord {
  return {
    id,
    aggregate_type: 'payment',
    aggregate_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    event_type: 'payment.captured.v1',
    event_version: 1,
    routing_key: 'payment.captured.v1',
    payload: {
      eventId: id,
      eventType: 'payment.captured.v1',
      eventVersion: 1,
      occurredAt: '2026-07-26T10:00:00.000Z',
      correlationId: 'worker-correlation',
      source: 'payment-service',
      payload: {
        paymentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    },
    status: 'PENDING',
    attempts: 0,
    next_retry_at: null,
    last_error: null,
    created_at: now,
    published_at: null,
    ...overrides,
  };
}

function createSubject(options: {
  env?: NodeJS.ProcessEnv;
  events?: OutboxEventRecord[];
} = {}) {
  const sequence: string[] = [];
  const outboxEventsDataAccess: jest.Mocked<OutboxEventsDataAccessPort> = {
    fetchPendingBatch: jest.fn().mockImplementation(async () => {
      sequence.push('fetch');
      return options.events ?? [];
    }),
    markPublished: jest.fn().mockImplementation(async () => {
      sequence.push('markPublished');
      return options.events?.[0] ?? null;
    }),
    markPublishFailed: jest.fn().mockImplementation(async () => {
      sequence.push('markPublishFailed');
      return options.events?.[0] ?? null;
    }),
  };
  const transactionManager = {
    run: jest.fn().mockImplementation(async (handler) => {
      sequence.push('transaction:start');
      try {
        return await handler(transaction);
      } finally {
        sequence.push('transaction:end');
      }
    }),
  };
  const rabbitMqPublisher = {
    publish: jest.fn().mockImplementation(async () => {
      sequence.push('publish');
    }),
  };
  const rabbitMqConnectionManager = {
    getConfirmChannel: jest.fn().mockImplementation(async () => {
      sequence.push('connect');
      return { id: 'confirm-channel' };
    }),
  };
  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  };
  const clock = {
    now: jest.fn().mockReturnValue(now),
  };
  const subject = new OutboxPublisherWorker({
    env: options.env ?? {},
    outboxEventsDataAccess,
    transactionManager,
    rabbitMqPublisher,
    rabbitMqConnectionManager,
    logger,
    clock,
  } as never);

  return {
    subject,
    outboxEventsDataAccess,
    transactionManager,
    rabbitMqPublisher,
    rabbitMqConnectionManager,
    logger,
    clock,
    sequence,
  };
}

describe('OutboxPublisherWorker', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['OUTBOX_POLL_INTERVAL_MS', '0'],
    ['OUTBOX_POLL_INTERVAL_MS', '1.5'],
    ['OUTBOX_BATCH_SIZE', '-1'],
    ['OUTBOX_BATCH_SIZE', 'NaN'],
    ['OUTBOX_MAX_ATTEMPTS', 'Infinity'],
    ['OUTBOX_RETRY_BASE_DELAY_MS', '0'],
    ['OUTBOX_RETRY_MAX_DELAY_MS', '-2'],
    ['OUTBOX_SHUTDOWN_GRACE_MS', '2.5'],
  ])('fails closed when %s is not a positive finite integer', (name, value) => {
    expect(() => createSubject({ env: { [name]: value } })).toThrow(name);
  });

  it('fetches, publishes, confirms, and marks the event published in one transaction', async () => {
    const event = buildEvent('11111111-1111-4111-8111-111111111111');
    const {
      subject,
      outboxEventsDataAccess,
      rabbitMqPublisher,
      sequence,
    } = createSubject({ events: [event] });

    await subject.pollOnce();

    expect(outboxEventsDataAccess.fetchPendingBatch).toHaveBeenCalledWith(
      50,
      transaction,
    );
    expect(rabbitMqPublisher.publish).toHaveBeenCalledWith(event);
    expect(outboxEventsDataAccess.markPublished).toHaveBeenCalledWith(
      event.id,
      transaction,
    );
    expect(sequence).toEqual([
      'connect',
      'transaction:start',
      'fetch',
      'publish',
      'markPublished',
      'transaction:end',
    ]);
  });

  it('does not call the publisher for an empty batch', async () => {
    const { subject, rabbitMqPublisher } = createSubject();

    await subject.pollOnce();

    expect(rabbitMqPublisher.publish).not.toHaveBeenCalled();
  });

  it('records a publish failure with default retry and maximum-attempt settings', async () => {
    const event = buildEvent('11111111-1111-4111-8111-111111111111');
    const {
      subject,
      rabbitMqPublisher,
      outboxEventsDataAccess,
    } = createSubject({ events: [event] });
    rabbitMqPublisher.publish.mockRejectedValue(new Error('broker nack'));

    await subject.pollOnce();

    expect(outboxEventsDataAccess.markPublishFailed).toHaveBeenCalledWith({
      id: event.id,
      lastError: 'broker nack',
      maxAttempts: 10,
      nextRetryAt: new Date(now.getTime() + 1_000),
    }, transaction);
  });

  it('does not consume an event attempt when publishing never reached a channel', async () => {
    const event = buildEvent('11111111-1111-4111-8111-111111111111');
    const {
      subject,
      rabbitMqPublisher,
      outboxEventsDataAccess,
    } = createSubject({ events: [event] });
    const connectionError = new RabbitMqPublishNotAttemptedError(
      new Error('reconnect failed'),
    );
    rabbitMqPublisher.publish.mockRejectedValue(connectionError);

    await expect(subject.pollOnce()).rejects.toBe(connectionError);

    expect(outboxEventsDataAccess.markPublishFailed).not.toHaveBeenCalled();
    expect(outboxEventsDataAccess.markPublished).not.toHaveBeenCalled();
  });

  it.each([
    [0, 1_000],
    [1, 2_000],
    [2, 4_000],
    [3, 5_000],
    [9, 5_000],
  ])(
    'uses capped exponential backoff for attempts=%i',
    async (attempts, expectedDelay) => {
      const event = buildEvent('11111111-1111-4111-8111-111111111111', {
        attempts,
      });
      const {
        subject,
        rabbitMqPublisher,
        outboxEventsDataAccess,
      } = createSubject({
        events: [event],
        env: {
          OUTBOX_RETRY_BASE_DELAY_MS: '1000',
          OUTBOX_RETRY_MAX_DELAY_MS: '5000',
        },
      });
      rabbitMqPublisher.publish.mockRejectedValue(new Error('publish failed'));

      await subject.pollOnce();

      expect(outboxEventsDataAccess.markPublishFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          id: event.id,
          maxAttempts: 10,
          nextRetryAt: new Date(now.getTime() + expectedDelay),
        }),
        transaction,
      );
    },
  );

  it('passes the configured max-attempt boundary without an off-by-one', async () => {
    const event = buildEvent('11111111-1111-4111-8111-111111111111', {
      attempts: 2,
    });
    const {
      subject,
      rabbitMqPublisher,
      outboxEventsDataAccess,
    } = createSubject({
      events: [event],
      env: { OUTBOX_MAX_ATTEMPTS: '3' },
    });
    rabbitMqPublisher.publish.mockRejectedValue(new Error('last attempt'));

    await subject.pollOnce();

    expect(outboxEventsDataAccess.markPublishFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: event.id,
        maxAttempts: 3,
      }),
      transaction,
    );
  });

  it('caps retry backoff at the default 60000 ms', async () => {
    const event = buildEvent('11111111-1111-4111-8111-111111111111', {
      attempts: 10,
    });
    const {
      subject,
      rabbitMqPublisher,
      outboxEventsDataAccess,
    } = createSubject({
      events: [event],
      env: { OUTBOX_MAX_ATTEMPTS: '100' },
    });
    rabbitMqPublisher.publish.mockRejectedValue(new Error('publish failed'));

    await subject.pollOnce();

    expect(outboxEventsDataAccess.markPublishFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: event.id,
        nextRetryAt: new Date(now.getTime() + 60_000),
      }),
      transaction,
    );
  });

  it('isolates expected failures per event and continues the mixed batch', async () => {
    const first = buildEvent('11111111-1111-4111-8111-111111111111');
    const second = buildEvent('22222222-2222-4222-8222-222222222222');
    const third = buildEvent('33333333-3333-4333-8333-333333333333');
    const {
      subject,
      rabbitMqPublisher,
      outboxEventsDataAccess,
    } = createSubject({ events: [first, second, third] });
    rabbitMqPublisher.publish
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second failed'))
      .mockResolvedValueOnce(undefined);

    await subject.pollOnce();

    expect(rabbitMqPublisher.publish.mock.calls.map(([event]) => event.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(outboxEventsDataAccess.markPublished.mock.calls.map(([id]) => id)).toEqual([
      first.id,
      third.id,
    ]);
    expect(outboxEventsDataAccess.markPublishFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: second.id, lastError: 'second failed' }),
      transaction,
    );
  });

  it('lets a database state-update error reject the transaction', async () => {
    const event = buildEvent('11111111-1111-4111-8111-111111111111');
    const { subject, outboxEventsDataAccess } = createSubject({ events: [event] });
    const databaseError = new Error('database update failed');
    outboxEventsDataAccess.markPublished.mockRejectedValue(databaseError);

    await expect(subject.pollOnce()).rejects.toBe(databaseError);
  });

  it('keeps the polling loop alive after an iteration error', async () => {
    jest.useFakeTimers();
    const { subject, transactionManager, logger } = createSubject({
      env: { OUTBOX_POLL_INTERVAL_MS: '10' },
    });
    transactionManager.run
      .mockRejectedValueOnce(new Error('temporary database failure'))
      .mockResolvedValueOnce(undefined);

    await subject.start();
    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(10);

    expect(transactionManager.run).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/outbox/i),
      expect.objectContaining({ error: expect.any(Error) }),
    );
    await subject.stop();
  });

  it('starts without waiting for an available broker', async () => {
    jest.useFakeTimers();
    const {
      subject,
      rabbitMqConnectionManager,
      transactionManager,
    } = createSubject({
      env: { OUTBOX_POLL_INTERVAL_MS: '10' },
    });
    rabbitMqConnectionManager.getConfirmChannel
      .mockRejectedValueOnce(new Error('broker unavailable'))
      .mockResolvedValueOnce({ id: 'reconnected-channel' });

    await expect(subject.start()).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(10);

    expect(transactionManager.run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(10);
    expect(transactionManager.run).toHaveBeenCalledTimes(1);
    await subject.stop();
  });

  it('uses the default 1000 ms polling interval', async () => {
    jest.useFakeTimers();
    const { subject, transactionManager } = createSubject();

    await subject.start();
    await jest.advanceTimersByTimeAsync(999);
    expect(transactionManager.run).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(transactionManager.run).toHaveBeenCalledTimes(1);
    await subject.stop();
  });

  it('never overlaps polling iterations', async () => {
    jest.useFakeTimers();
    const inFlight = deferred();
    const { subject, transactionManager } = createSubject({
      env: { OUTBOX_POLL_INTERVAL_MS: '10' },
    });
    transactionManager.run.mockReturnValue(inFlight.promise);

    await subject.start();
    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(100);
    expect(transactionManager.run).toHaveBeenCalledTimes(1);

    inFlight.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10);
    expect(transactionManager.run).toHaveBeenCalledTimes(2);

    inFlight.resolve();
    await subject.stop();
  });

  it('start and stop are idempotent, stop prevents new polls and waits for in-flight work', async () => {
    jest.useFakeTimers();
    const inFlight = deferred();
    const { subject, transactionManager } = createSubject({
      env: {
        OUTBOX_POLL_INTERVAL_MS: '10',
        OUTBOX_SHUTDOWN_GRACE_MS: '30000',
      },
    });
    transactionManager.run.mockReturnValue(inFlight.promise);

    await subject.start();
    await subject.start();
    await jest.advanceTimersByTimeAsync(10);
    expect(transactionManager.run).toHaveBeenCalledTimes(1);

    let stopped = false;
    const firstStop = subject.stop().then(() => {
      stopped = true;
    });
    const secondStop = subject.stop();
    await Promise.resolve();
    expect(stopped).toBe(false);

    inFlight.resolve();
    await Promise.all([firstStop, secondStop]);
    await jest.advanceTimersByTimeAsync(100);
    expect(transactionManager.run).toHaveBeenCalledTimes(1);
  });

  it('cannot restart while stop overlaps an in-flight iteration or after stop completes', async () => {
    jest.useFakeTimers();
    const inFlight = deferred();
    const { subject, transactionManager } = createSubject({
      env: { OUTBOX_POLL_INTERVAL_MS: '10' },
    });
    transactionManager.run.mockReturnValue(inFlight.promise);

    await subject.start();
    await jest.advanceTimersByTimeAsync(10);
    const stopping = subject.stop();

    await expect(subject.start()).rejects.toThrow(/cannot restart/i);
    inFlight.resolve();
    await stopping;
    await expect(subject.start()).rejects.toThrow(/cannot restart/i);
    await jest.advanceTimersByTimeAsync(100);

    expect(transactionManager.run).toHaveBeenCalledTimes(1);
  });
});
