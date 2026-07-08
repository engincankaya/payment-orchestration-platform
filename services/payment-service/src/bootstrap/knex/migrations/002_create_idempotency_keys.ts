import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('idempotency_keys', (table) => {
    table.uuid('id').primary();
    table.string('scope', 120).notNullable();
    table.string('idempotency_key', 160).notNullable();
    table.string('request_hash', 128).notNullable();
    table.string('status', 30).notNullable();
    table.string('resource_type', 80);
    table.uuid('resource_id');
    table.integer('response_status_code');
    table.jsonb('response_body');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('expires_at');

    table.unique(['scope', 'idempotency_key']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('idempotency_keys');
}
