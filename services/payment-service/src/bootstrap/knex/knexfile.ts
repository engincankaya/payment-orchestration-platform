import { Knex } from 'knex';
import path from 'path';

const connection = process.env.DATABASE_URL;

const config: Record<string, Knex.Config> = {
  development: {
    client: 'pg',
    connection,
    migrations: {
      directory: path.join(__dirname, 'migrations'),
      extension: 'ts',
    },
  },
  production: {
    client: 'pg',
    connection,
    migrations: {
      directory: path.join(__dirname, 'migrations'),
      extension: 'js',
    },
  },
};

export default config;
