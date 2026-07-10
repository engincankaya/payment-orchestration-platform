import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('idempotency_keys', (table) => {
    table.timestamp('processing_expires_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('idempotency_keys', (table) => {
    table.dropColumn('processing_expires_at');
  });
}
