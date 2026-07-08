import {
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
  Lifetime,
} from 'awilix';

import knex from './knex/knex';
import ServerApplication from '../server/server';
import logger from '../utils/logger';

const container = createContainer({
  injectionMode: InjectionMode.PROXY,
});

container.register({
  container: asValue(container),
  env: asValue(process.env),
  knex: asValue(knex),
  logger: asFunction(logger).singleton(),
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

container.loadModules(['../consumers/**/*.{ts,js}', '../jobs/**/*.{ts,js}'], {
  cwd: __dirname,
  formatName: 'camelCase',
  resolverOptions: { lifetime: Lifetime.SINGLETON },
});

export default container;
