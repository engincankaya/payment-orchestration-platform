import { EventEmitter } from 'node:events';

import RabbitMqConnectionManager from '../../src/messaging/rabbitmq-connection-manager';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeConfirmChannel extends EventEmitter {
  public assertExchange = jest.fn().mockResolvedValue({ exchange: 'payments.events' });
  public close = jest.fn().mockResolvedValue(undefined);
}

class FakeConnection extends EventEmitter {
  public createConfirmChannel = jest.fn();
  public close = jest.fn().mockResolvedValue(undefined);
}

function createSubject(env: NodeJS.ProcessEnv = {
  RABBITMQ_URL: 'amqp://rabbitmq:5672',
}) {
  const channels = [new FakeConfirmChannel(), new FakeConfirmChannel()];
  const connections = [new FakeConnection(), new FakeConnection()];
  connections.forEach((connection, index) => {
    connection.createConfirmChannel.mockResolvedValue(channels[index]);
  });
  const amqpClient = {
    connect: jest.fn()
      .mockResolvedValueOnce(connections[0])
      .mockResolvedValueOnce(connections[1]),
  };
  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  };

  const subject = new RabbitMqConnectionManager({
    env,
    amqpClient,
    logger,
  } as never);

  return { subject, amqpClient, channels, connections, logger };
}

describe('RabbitMqConnectionManager', () => {
  it.each([
    [undefined],
    [''],
    ['rabbitmq:5672'],
    ['http://rabbitmq:5672'],
    ['not a url'],
  ])('fails closed for a missing or invalid RABBITMQ_URL (%p)', (rabbitMqUrl) => {
    expect(() => createSubject({ RABBITMQ_URL: rabbitMqUrl })).toThrow(
      /RABBITMQ_URL/,
    );
  });

  it.each([
    'amqp://rabbitmq:5672',
    'amqps://rabbitmq.example.test',
  ])('accepts a structurally valid RabbitMQ URL (%s)', (rabbitMqUrl) => {
    expect(() => createSubject({ RABBITMQ_URL: rabbitMqUrl })).not.toThrow();
  });

  it('creates one confirm channel, asserts the durable topic exchange, and reuses it', async () => {
    const { subject, amqpClient, channels, connections } = createSubject();

    const first = await subject.getConfirmChannel();
    const second = await subject.getConfirmChannel();

    expect(first).toBe(channels[0]);
    expect(second).toBe(first);
    expect(amqpClient.connect).toHaveBeenCalledTimes(1);
    expect(connections[0].createConfirmChannel).toHaveBeenCalledTimes(1);
    expect(channels[0].assertExchange).toHaveBeenCalledWith(
      'payments.events',
      'topic',
      expect.objectContaining({ durable: true }),
    );
    expect(channels[0].listenerCount('return')).toBeGreaterThan(0);
  });

  it.each(['error', 'close'] as const)(
    'reconnects, reasserts the exchange, and restores return handling after channel %s',
    async (eventName) => {
      const { subject, amqpClient, channels } = createSubject();
      await subject.getConfirmChannel();

      channels[0].emit(eventName, new Error(`channel ${eventName}`));
      const reconnected = await subject.getConfirmChannel();

      expect(reconnected).toBe(channels[1]);
      expect(amqpClient.connect).toHaveBeenCalledTimes(2);
      expect(channels[1].assertExchange).toHaveBeenCalledWith(
        'payments.events',
        'topic',
        expect.objectContaining({ durable: true }),
      );
      expect(channels[1].listenerCount('return')).toBeGreaterThan(0);
    },
  );

  it.each(['error', 'close'] as const)(
    'reconnects after connection %s',
    async (eventName) => {
      const { subject, amqpClient, channels, connections } = createSubject();
      await subject.getConfirmChannel();

      connections[0].emit(eventName, new Error(`connection ${eventName}`));
      const reconnected = await subject.getConfirmChannel();

      expect(reconnected).toBe(channels[1]);
      expect(amqpClient.connect).toHaveBeenCalledTimes(2);
      expect(channels[1].assertExchange).toHaveBeenCalledTimes(1);
      expect(channels[1].listenerCount('return')).toBeGreaterThan(0);
    },
  );

  it('propagates connection failures to the caller so the worker can retry', async () => {
    const { subject, amqpClient } = createSubject();
    const connectionError = new Error('broker unavailable');
    amqpClient.connect.mockReset().mockRejectedValue(connectionError);

    await expect(subject.getConfirmChannel()).rejects.toBe(connectionError);
    await expect(subject.getConfirmChannel()).rejects.toBe(connectionError);
    expect(amqpClient.connect).toHaveBeenCalledTimes(2);
  });

  it('invalidates the current channel and closes owned resources idempotently', async () => {
    const { subject, channels, connections } = createSubject();
    await subject.getConfirmChannel();

    await subject.invalidateChannel(channels[0] as never);
    await subject.close();
    await subject.close();

    expect(channels[0].close).toHaveBeenCalledTimes(1);
    expect(connections[0].close).toHaveBeenCalledTimes(1);
  });

  it('owns and closes a connection attempt that completes during shutdown', async () => {
    const { subject, amqpClient, channels, connections } = createSubject();
    const connecting = deferred<FakeConnection>();
    amqpClient.connect.mockReset().mockReturnValue(connecting.promise);

    const channelRequest = subject.getConfirmChannel();
    const channelResult = expect(channelRequest).rejects.toThrow(/closed/i);
    await Promise.resolve();
    const closing = subject.close();
    await Promise.resolve();

    expect(connections[0].close).not.toHaveBeenCalled();
    connecting.resolve(connections[0]);
    await channelResult;
    await closing;

    expect(connections[0].createConfirmChannel).not.toHaveBeenCalled();
    expect(channels[0].close).not.toHaveBeenCalled();
    expect(connections[0].close).toHaveBeenCalledTimes(1);
    await expect(subject.getConfirmChannel()).rejects.toThrow(/closed/i);
  });

  it('aborts a never-settling connection attempt so close remains bounded', async () => {
    const { subject, amqpClient } = createSubject();
    amqpClient.connect.mockReset().mockImplementation((
      _url,
      options,
    ) => new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => reject(new Error('connection aborted')),
        { once: true },
      );
    }));

    const channelRequest = subject.getConfirmChannel();
    const channelResult = expect(channelRequest).rejects.toThrow(
      /connection aborted/i,
    );
    await Promise.resolve();

    await expect(subject.close()).resolves.toBeUndefined();
    await channelResult;
    expect(amqpClient.connect).toHaveBeenCalledWith(
      'amqp://rabbitmq:5672',
      {
        signal: expect.any(AbortSignal),
        timeout: 10_000,
      },
    );
  });
});
