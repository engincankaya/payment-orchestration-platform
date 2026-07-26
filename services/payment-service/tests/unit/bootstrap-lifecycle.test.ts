import PaymentServiceBootstrap from '../../src/bootstrap/payment-service-bootstrap';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createSubject(options: {
  listenGate?: { promise: Promise<void> };
  workerStart?: () => Promise<void>;
  workerStop?: () => Promise<void>;
  shutdownGraceMs?: string;
} = {}) {
  const sequence: string[] = [];
  const httpServer = {
    close: jest.fn().mockImplementation((callback?: (error?: Error) => void) => {
      sequence.push('http:close');
      callback?.();
      return httpServer;
    }),
  };
  const app = {
    listen: jest.fn().mockImplementation((
      _port: number,
      callback?: () => void,
    ) => {
      sequence.push('http:listen');
      if (options.listenGate) {
        void options.listenGate.promise.then(() => callback?.());
      } else {
        callback?.();
      }
      return httpServer;
    }),
  };
  const outboxPublisherWorker = {
    start: jest.fn().mockImplementation(options.workerStart ?? (async () => {
      sequence.push('worker:start');
    })),
    stop: jest.fn().mockImplementation(options.workerStop ?? (async () => {
      sequence.push('worker:stop');
    })),
  };
  const rabbitMqConnectionManager = {
    close: jest.fn().mockImplementation(async () => {
      sequence.push('rabbitmq:close');
    }),
  };
  const knex = {
    destroy: jest.fn().mockImplementation(async () => {
      sequence.push('knex:destroy');
    }),
  };
  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  };
  const env: NodeJS.ProcessEnv = {
    PORT: '8080',
  };
  if (options.shutdownGraceMs !== undefined) {
    env.OUTBOX_SHUTDOWN_GRACE_MS = options.shutdownGraceMs;
  }
  const subject = new PaymentServiceBootstrap({
    server: { app },
    outboxPublisherWorker,
    rabbitMqConnectionManager,
    knex,
    logger,
    env,
  } as never);

  return {
    subject,
    app,
    httpServer,
    outboxPublisherWorker,
    rabbitMqConnectionManager,
    knex,
    logger,
    sequence,
  };
}

describe('PaymentServiceBootstrap', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts the outbox worker only after the HTTP server is listening', async () => {
    const { subject, app, outboxPublisherWorker, sequence } = createSubject();

    await subject.bootstrap();

    expect(app.listen).toHaveBeenCalledWith(8080, expect.any(Function));
    expect(outboxPublisherWorker.start).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual(['http:listen', 'worker:start']);
  });

  it('does not require RabbitMQ reachability to start HTTP', async () => {
    const { subject, app } = createSubject({
      workerStart: async () => undefined,
    });

    await expect(subject.bootstrap()).resolves.toBeUndefined();

    expect(app.listen).toHaveBeenCalledTimes(1);
  });

  it('shuts down HTTP, worker, RabbitMQ, then the Payment Service Knex pool', async () => {
    const {
      subject,
      outboxPublisherWorker,
      rabbitMqConnectionManager,
      knex,
      sequence,
    } = createSubject();
    await subject.bootstrap();
    sequence.length = 0;

    await subject.shutdown();

    expect(outboxPublisherWorker.stop).toHaveBeenCalledTimes(1);
    expect(rabbitMqConnectionManager.close).toHaveBeenCalledTimes(1);
    expect(knex.destroy).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual([
      'http:close',
      'worker:stop',
      'rabbitmq:close',
      'knex:destroy',
    ]);
  });

  it('closes RabbitMQ after the shutdown grace expires so a pending confirm can settle', async () => {
    jest.useFakeTimers();
    const inFlightStop = deferred();
    const {
      subject,
      rabbitMqConnectionManager,
      knex,
      sequence,
    } = createSubject({
      workerStop: () => inFlightStop.promise,
      shutdownGraceMs: '25',
    });
    await subject.bootstrap();
    sequence.length = 0;

    const shuttingDown = subject.shutdown();
    await jest.advanceTimersByTimeAsync(24);
    expect(rabbitMqConnectionManager.close).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(rabbitMqConnectionManager.close).toHaveBeenCalledTimes(1);
    expect(knex.destroy).not.toHaveBeenCalled();

    inFlightStop.resolve();
    await shuttingDown;
    expect(sequence).toEqual([
      'http:close',
      'rabbitmq:close',
      'knex:destroy',
    ]);
  });

  it('uses the default 30000 ms shutdown grace', async () => {
    jest.useFakeTimers();
    const inFlightStop = deferred();
    const {
      subject,
      rabbitMqConnectionManager,
    } = createSubject({
      workerStop: () => inFlightStop.promise,
      shutdownGraceMs: undefined,
    });
    await subject.bootstrap();

    const shuttingDown = subject.shutdown();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(rabbitMqConnectionManager.close).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(rabbitMqConnectionManager.close).toHaveBeenCalledTimes(1);
    inFlightStop.resolve();
    await shuttingDown;
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'routes %s through the same idempotent shutdown path',
    async (signal) => {
      const {
        subject,
        httpServer,
        rabbitMqConnectionManager,
        knex,
      } = createSubject();
      await subject.bootstrap();

      await subject.handleSignal(signal);
      await subject.handleSignal(signal);

      expect(httpServer.close).toHaveBeenCalledTimes(1);
      expect(rabbitMqConnectionManager.close).toHaveBeenCalledTimes(1);
      expect(knex.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it('does not start the worker when shutdown overlaps HTTP startup', async () => {
    const listenGate = deferred();
    const {
      subject,
      httpServer,
      outboxPublisherWorker,
      rabbitMqConnectionManager,
      knex,
    } = createSubject({ listenGate });

    const booting = subject.bootstrap();
    await Promise.resolve();
    const shuttingDown = subject.shutdown();
    listenGate.resolve();

    await shuttingDown;
    await expect(booting).rejects.toThrow(/shutdown interrupted bootstrap/i);
    expect(outboxPublisherWorker.start).not.toHaveBeenCalled();
    expect(httpServer.close).toHaveBeenCalledTimes(1);
    expect(rabbitMqConnectionManager.close).toHaveBeenCalledTimes(1);
    expect(knex.destroy).toHaveBeenCalledTimes(1);
    await expect(subject.bootstrap()).rejects.toThrow(/after shutdown/i);
  });
});
