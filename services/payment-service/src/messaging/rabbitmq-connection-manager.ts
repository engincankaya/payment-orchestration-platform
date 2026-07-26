import type {
  ChannelModel,
  ConfirmChannel,
  Message,
} from 'amqplib';

import type { Logger } from '../utils/logger';

const PAYMENTS_EXCHANGE = 'payments.events';
const CONNECTION_TIMEOUT_MS = 10_000;

interface AmqpConnectOptions {
  signal: AbortSignal;
  timeout: number;
}

export interface AmqpClientPort {
  connect(url: string, options: AmqpConnectOptions): Promise<ChannelModel>;
}

export type ReturnedMessageHandler = (message: Message) => void;

export default class RabbitMqConnectionManager {
  private readonly amqpClient: AmqpClientPort;
  private readonly logger: Logger;
  private readonly rabbitMqUrl: string;
  private readonly returnedMessageHandlers = new Set<ReturnedMessageHandler>();
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private connecting: Promise<ConfirmChannel> | null = null;
  private connectionAbortController: AbortController | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(deps: {
    amqpClient: AmqpClientPort;
    env: NodeJS.ProcessEnv;
    logger: Logger;
  }) {
    this.amqpClient = deps.amqpClient;
    this.logger = deps.logger;
    this.rabbitMqUrl = this.parseRabbitMqUrl(deps.env.RABBITMQ_URL);
  }

  /** Returns the current confirm channel or reconnects and prepares a new one. */
  public getConfirmChannel = async (): Promise<ConfirmChannel> => {
    if (this.closed) {
      throw new Error('RabbitMQ connection manager is closed');
    }
    if (this.channel) {
      return this.channel;
    }
    if (!this.connecting) {
      this.connecting = this.connectConfirmChannel();
    }

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  };

  /** Subscribes to mandatory messages returned by RabbitMQ. */
  public onReturnedMessage = (handler: ReturnedMessageHandler) => {
    this.returnedMessageHandlers.add(handler);
    return () => this.returnedMessageHandlers.delete(handler);
  };

  /** Invalidates and closes a channel after an ambiguous publish outcome. */
  public invalidateChannel = async (channel: ConfirmChannel): Promise<void> => {
    if (this.channel !== channel) {
      return;
    }

    this.channel = null;
    this.detachChannelListeners(channel);
    await this.safeClose(channel);
  };

  /** Closes the owned RabbitMQ channel and connection idempotently. */
  public close = async (): Promise<void> => {
    if (!this.closePromise) {
      this.closePromise = this.closeResources();
    }
    return this.closePromise;
  };

  private connectConfirmChannel = async () => {
    const connection = this.connection ?? await this.connect();

    try {
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange(PAYMENTS_EXCHANGE, 'topic', {
        durable: true,
      });
      this.attachChannelListeners(channel, connection);
      this.channel = channel;
      return channel;
    } catch (error) {
      if (this.connection === connection) {
        this.connection = null;
      }
      await this.safeClose(connection);
      throw error;
    }
  };

  private connect = async () => {
    const abortController = new AbortController();
    this.connectionAbortController = abortController;
    try {
      const connection = await this.amqpClient.connect(this.rabbitMqUrl, {
        signal: abortController.signal,
        timeout: CONNECTION_TIMEOUT_MS,
      });
      if (this.closed) {
        await this.safeClose(connection);
        throw new Error('RabbitMQ connection manager is closed');
      }
      this.connection = connection;
      connection.on('error', (error) => {
        this.invalidateConnection(connection, error);
      });
      connection.on('close', () => {
        this.invalidateConnection(connection);
      });
      return connection;
    } finally {
      if (this.connectionAbortController === abortController) {
        this.connectionAbortController = null;
      }
    }
  };

  private attachChannelListeners(
    channel: ConfirmChannel,
    connection: ChannelModel,
  ) {
    channel.on('return', this.forwardReturnedMessage);
    channel.on('error', (error) => {
      this.invalidateTransport(channel, connection, error);
    });
    channel.on('close', () => {
      this.invalidateTransport(channel, connection);
    });
  }

  private detachChannelListeners(channel: ConfirmChannel) {
    channel.removeListener('return', this.forwardReturnedMessage);
  }

  private forwardReturnedMessage = (message: Message) => {
    for (const handler of this.returnedMessageHandlers) {
      handler(message);
    }
  };

  private invalidateTransport(
    channel: ConfirmChannel,
    connection: ChannelModel,
    error?: unknown,
  ) {
    if (this.channel !== channel) {
      return;
    }

    this.detachChannelListeners(channel);
    this.channel = null;
    if (this.connection === connection) {
      this.connection = null;
    }
    this.logInvalidation('RabbitMQ channel invalidated', error);
    void this.safeClose(connection);
  }

  private invalidateConnection(connection: ChannelModel, error?: unknown) {
    if (this.connection !== connection) {
      return;
    }

    if (this.channel) {
      this.detachChannelListeners(this.channel);
    }
    this.channel = null;
    this.connection = null;
    this.logInvalidation('RabbitMQ connection invalidated', error);
  }

  private logInvalidation(message: string, error?: unknown) {
    this.logger.warn(message, error ? { error } : undefined);
  }

  private closeResources = async () => {
    this.closed = true;
    this.connectionAbortController?.abort();
    const connecting = this.connecting;
    if (connecting) {
      await connecting.catch(() => undefined);
    }
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;

    if (channel) {
      this.detachChannelListeners(channel);
      await this.safeClose(channel);
    }
    if (connection) {
      await this.safeClose(connection);
    }
  };

  private safeClose = async (resource: { close(): Promise<void> }) => {
    try {
      await resource.close();
    } catch (error) {
      this.logger.warn('RabbitMQ resource close failed', { error });
    }
  };

  private parseRabbitMqUrl(value: string | undefined) {
    if (!value) {
      throw new Error('RABBITMQ_URL is required');
    }

    try {
      const parsed = new URL(value);
      if (
        !['amqp:', 'amqps:'].includes(parsed.protocol)
        || parsed.hostname.length === 0
      ) {
        throw new Error('unsupported RabbitMQ URL');
      }
      return value;
    } catch {
      throw new Error('RABBITMQ_URL must be a valid amqp:// or amqps:// URL');
    }
  }
}
