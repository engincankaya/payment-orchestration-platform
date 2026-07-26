import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('outbox_events', (table) => {
    table.uuid('id').primary();
    table.string('aggregate_type', 80).notNullable();
    table.uuid('aggregate_id').notNullable();
    table.string('event_type', 120).notNullable();
    table.integer('event_version').notNullable();
    table.string('routing_key', 160).notNullable();
    table.jsonb('payload').notNullable();
    table.string('status', 30).notNullable().defaultTo('PENDING');
    table.integer('attempts').notNullable().defaultTo(0);
    table.timestamp('next_retry_at').nullable();
    table.text('last_error').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('published_at').nullable();

    table.index(
      ['status', 'next_retry_at', 'created_at', 'id'],
      'idx_outbox_pending',
    );
    table.index(
      ['aggregate_type', 'aggregate_id'],
      'idx_outbox_aggregate',
    );
  });

  await knex.schema.raw(`
    ALTER TABLE outbox_events
      ADD CONSTRAINT outbox_events_status_check
        CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
      ADD CONSTRAINT outbox_events_attempts_check
        CHECK (attempts >= 0),
      ADD CONSTRAINT outbox_events_event_version_check
        CHECK (event_version > 0);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('outbox_events');
}
