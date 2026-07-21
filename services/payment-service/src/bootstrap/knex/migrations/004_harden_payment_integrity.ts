import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    ALTER TABLE payments
      ADD CONSTRAINT payments_amount_minor_positive_check CHECK (amount_minor > 0),
      ADD CONSTRAINT payments_status_check CHECK (status IN ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CAPTURE_FAILED')),
      ADD CONSTRAINT payments_currency_check CHECK (currency IN ('TRY', 'USD', 'EUR'));
  `);

  await knex.schema.raw(`
    ALTER TABLE idempotency_keys
      ADD CONSTRAINT idempotency_keys_status_check CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED'));
  `);

  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.schema.raw(`
    CREATE TRIGGER trg_payments_set_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `);

  await knex.schema.raw(`
    CREATE TRIGGER trg_idempotency_keys_set_updated_at
    BEFORE UPDATE ON idempotency_keys
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP TRIGGER IF EXISTS trg_idempotency_keys_set_updated_at ON idempotency_keys');
  await knex.schema.raw('DROP TRIGGER IF EXISTS trg_payments_set_updated_at ON payments');
  await knex.schema.raw('DROP FUNCTION IF EXISTS set_updated_at');
  await knex.schema.raw('ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_status_check');
  await knex.schema.raw(`
    ALTER TABLE payments
      DROP CONSTRAINT IF EXISTS payments_currency_check,
      DROP CONSTRAINT IF EXISTS payments_status_check,
      DROP CONSTRAINT IF EXISTS payments_amount_minor_positive_check;
  `);
}
