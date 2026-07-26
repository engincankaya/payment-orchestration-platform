import {
  asClass,
  asFunction,
  asValue,
  AwilixContainer,
  createContainer,
  InjectionMode,
  Lifetime,
  NameAndRegistrationPair,
} from 'awilix';
import * as amqpClient from 'amqplib';

import knex from './knex/knex';
import PaymentServiceBootstrap from './payment-service-bootstrap';
import RabbitMqConnectionManager from '../messaging/rabbitmq-connection-manager';
import RabbitMqPublisher from '../messaging/rabbitmq-publisher';
import ServerApplication from '../server/server';
import logger from '../utils/logger';

export function buildContainer(
  overrides: NameAndRegistrationPair<unknown> = {},
): AwilixContainer {
  const container = createContainer({
    injectionMode: InjectionMode.PROXY,
  });

  container.register({
    container: asValue(container),
    env: asValue(process.env),
    amqpClient: asValue(amqpClient),
    clock: asValue({ now: () => new Date() }),
    knex: asValue(knex),
    logger: asFunction(logger).singleton(),
    paymentServiceBootstrap: asClass(PaymentServiceBootstrap).singleton(),
    rabbitMqConnectionManager: asClass(RabbitMqConnectionManager).singleton(),
    rabbitMqPublisher: asClass(RabbitMqPublisher).singleton(),
    server: asClass(ServerApplication).singleton(),
  });

  container.loadModules(['../data-access/**/*.{ts,js}'], {
    cwd: __dirname,
    formatName: 'camelCase',
    resolverOptions: { lifetime: Lifetime.SINGLETON },
  });

  container.loadModules(['../services/**/*.{ts,js}'], {
    cwd: __dirname,
    formatName: 'camelCase',
    resolverOptions: { lifetime: Lifetime.SINGLETON },
  });

  container.loadModules(['../server/middlewares/**/*.{ts,js}'], {
    cwd: __dirname,
    formatName: 'camelCase',
    resolverOptions: { lifetime: Lifetime.SINGLETON },
  });

  // Controllers are scoped so request-level dependencies can be introduced later without changing wiring.
  container.loadModules(['../server/controllers/**/*.{ts,js}'], {
    cwd: __dirname,
    formatName: 'camelCase',
    resolverOptions: { lifetime: Lifetime.SCOPED },
  });

  container.loadModules(['../workers/**/*.{ts,js}'], {
    cwd: __dirname,
    formatName: 'camelCase',
    resolverOptions: { lifetime: Lifetime.SINGLETON },
  });

  container.register(overrides);

  return container;
}

export default buildContainer();
