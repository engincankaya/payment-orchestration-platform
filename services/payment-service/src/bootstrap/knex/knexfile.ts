import { Knex } from 'knex';

const connection = process.env.DATABASE_URL;

const config: Record<string, Knex.Config> = {
  development: {
    client: 'pg',
    connection,
    migrations: {
      directory: './migrations',
      extension: 'ts',
    },
  },
  production: {
    client: 'pg',
    connection,
    migrations: {
      directory: './migrations',
      extension: 'js',
    },
  },
};

export default config;
