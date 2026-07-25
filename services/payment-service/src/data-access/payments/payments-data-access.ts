import type { Knex } from 'knex';

import BaseDataAccess from '../base-data-access';
import type { TransactionContext } from '../transaction-manager';

export interface PaymentRecord {
  id: string;
  merchant_id: string;
  amount_minor: string;
  currency: string;
  status: string;
  provider: string;
  provider_payment_id?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
  authorized_at?: Date | string | null;
  captured_at?: Date | string | null;
  failed_at?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface InsertPaymentRecord {
  id: string;
  merchant_id: string;
  amount_minor: string;
  currency: string;
  status: string;
  provider: string;
  provider_payment_id?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
  authorized_at?: Date | null;
  failed_at?: Date | null;
}

export interface UpdateAuthorizedPaymentStatusInput {
  id: string;
  status: string;
  captured_at: Date | null;
  failed_at: Date | null;
  failure_code: string | null;
  failure_message: string | null;
}

export default class PaymentsDataAccess extends BaseDataAccess<PaymentRecord> {
  constructor(deps: { knex: Knex }) {
    super(deps, 'payments');
  }

  public insert = async (record: InsertPaymentRecord, trx?: TransactionContext) => {
    const [payment] = await this.query(trx).insert(record).returning('*');
    return payment;
  };

  public findById = async (id: string, trx?: TransactionContext) => {
    return this.query(trx).where({ id }).first();
  };

  /** Reads and locks a payment row within the provided transaction. */
  public findByIdForUpdate = async (id: string, trx: TransactionContext) => {
    return this.query(trx).where({ id }).forUpdate().first();
  };

  /** Updates a payment only while its current status is AUTHORIZED. */
  public updateStatusIfAuthorized = async (
    input: UpdateAuthorizedPaymentStatusInput,
    trx: TransactionContext,
  ) => {
    const [payment] = await this.query(trx)
      .where({
        id: input.id,
        status: 'AUTHORIZED',
      })
      .update({
        status: input.status,
        captured_at: input.captured_at,
        failed_at: input.failed_at,
        failure_code: input.failure_code,
        failure_message: input.failure_message,
      })
      .returning('*');

    return payment ?? null;
  };
}
