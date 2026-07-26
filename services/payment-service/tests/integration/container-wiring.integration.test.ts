import { asValue } from 'awilix';
import knexFactory, { Knex } from 'knex';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { buildContainer } from '../../src/bootstrap/container';
import type PaymentsService from '../../src/services/payments/payments-service';
import type OutboxService from '../../src/services/outbox/outbox-service';
import type ServerApplication from '../../src/server/server';
import type RabbitMqConnectionManager from '../../src/messaging/rabbitmq-connection-manager';
import type RabbitMqPublisher from '../../src/messaging/rabbitmq-publisher';
import type OutboxPublisherWorker from '../../src/workers/outbox-publisher-worker';
import type PaymentServiceBootstrap from '../../src/bootstrap/payment-service-bootstrap';

const postgresUser = 'container_wiring_test';
const postgresPassword = 'container_wiring_test';
const postgresDatabase = 'container_wiring_test';

function buildPostgresConnectionUri(container: StartedTestContainer) {
  return `postgres://${postgresUser}:${postgresPassword}@${container.getHost()}:${container.getMappedPort(5432)}/${postgresDatabase}`;
}

describe('Payment Service container outbox wiring', () => {
  let postgres: StartedTestContainer;
  let knex: Knex;

  beforeAll(async () => {
    postgres = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: postgresUser,
        POSTGRES_PASSWORD: postgresPassword,
        POSTGRES_DB: postgresDatabase,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start();
    knex = knexFactory({
      client: 'pg',
      connection: buildPostgresConnectionUri(postgres),
      pool: { min: 0, max: 2 },
    });
  }, 120_000);

  afterAll(async () => {
    await knex?.destroy();
    await postgres?.stop();
  });

  it('resolves server and concrete outbox dependencies from the real container as singletons', () => {
    const container = buildContainer({
      env: asValue({
        INTERNAL_SERVICE_TOKEN: 'container-wiring-token',
        SERVICE_NAME: 'payment-service-test',
      }),
      knex: asValue(knex),
    });

    expect(() => container.resolve<ServerApplication>('server')).not.toThrow();

    const paymentsService = container.resolve<PaymentsService>('paymentsService');
    const firstOutboxService = container.resolve<OutboxService>('outboxService');
    const secondOutboxService = container.resolve<OutboxService>('outboxService');
    const firstDataAccess = container.resolve('outboxEventsDataAccess');
    const secondDataAccess = container.resolve('outboxEventsDataAccess');

    expect(paymentsService).toBeDefined();
    expect(firstOutboxService).toBe(secondOutboxService);
    expect(firstDataAccess).toBe(secondDataAccess);
  });

  it('resolves messaging, worker, and bootstrap dependencies as singletons', () => {
    const container = buildContainer({
      env: asValue({
        INTERNAL_SERVICE_TOKEN: 'container-wiring-token',
        SERVICE_NAME: 'payment-service-test',
        RABBITMQ_URL: 'amqp://rabbitmq.invalid:5672',
      }),
      knex: asValue(knex),
    });

    const firstManager = container.resolve<RabbitMqConnectionManager>(
      'rabbitMqConnectionManager',
    );
    const secondManager = container.resolve<RabbitMqConnectionManager>(
      'rabbitMqConnectionManager',
    );
    const firstPublisher = container.resolve<RabbitMqPublisher>('rabbitMqPublisher');
    const secondPublisher = container.resolve<RabbitMqPublisher>('rabbitMqPublisher');
    const firstWorker = container.resolve<OutboxPublisherWorker>('outboxPublisherWorker');
    const secondWorker = container.resolve<OutboxPublisherWorker>('outboxPublisherWorker');
    const firstBootstrap = container.resolve<PaymentServiceBootstrap>(
      'paymentServiceBootstrap',
    );
    const secondBootstrap = container.resolve<PaymentServiceBootstrap>(
      'paymentServiceBootstrap',
    );

    expect(firstManager).toBe(secondManager);
    expect(firstPublisher).toBe(secondPublisher);
    expect(firstWorker).toBe(secondWorker);
    expect(firstBootstrap).toBe(secondBootstrap);
  });
});
