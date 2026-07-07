import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('payments', (table) => {
    table.uuid('id').primary();
    table.uuid('merchant_id').notNullable();
    table.bigInteger('amount_minor').notNullable();
    table.string('currency', 3).notNullable();
    table.string('status', 40).notNullable();
    table.string('provider', 50).notNullable();
    table.string('provider_payment_id', 120);
    table.string('failure_code', 80);
    table.text('failure_message');
    table.timestamp('authorized_at');
    table.timestamp('captured_at');
    table.timestamp('failed_at');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw('CREATE INDEX idx_payments_merchant_id ON payments(merchant_id)');
  await knex.schema.raw('CREATE INDEX idx_payments_provider_payment_id ON payments(provider_payment_id)');
  await knex.schema.raw('CREATE INDEX idx_payments_status ON payments(status)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payments');
}
