import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('idempotency_keys', (table) => {
    table.uuid('processing_token');
  });

  await knex.raw(`
    UPDATE idempotency_keys
    SET processing_token = gen_random_uuid()
    WHERE processing_token IS NULL
  `);

  const [{ count }] = await knex('idempotency_keys')
    .whereNull('processing_token')
    .count<{ count: string }[]>('* as count');

  if (Number(count) !== 0) {
    throw new Error('processing_token backfill left NULL idempotency rows');
  }

  await knex.schema.alterTable('idempotency_keys', (table) => {
    table.uuid('processing_token').notNullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('idempotency_keys', (table) => {
    table.dropColumn('processing_token');
  });
}
