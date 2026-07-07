import knexFactory from 'knex';

const knex = knexFactory({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: {
    min: 0,
    max: 10,
  },
});

export default knex;
