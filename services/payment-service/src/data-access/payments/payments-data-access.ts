import { Knex } from 'knex';

import BaseDataAccess from '../base-data-access';

export interface PaymentRecord {
  id: string;
  merchant_id: string;
  amount_minor: number;
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
  amount_minor: number;
  currency: string;
  status: string;
  provider: string;
  provider_payment_id?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
  authorized_at?: Date | null;
  failed_at?: Date | null;
}

export default class PaymentsDataAccess extends BaseDataAccess<PaymentRecord> {
  constructor(deps: { knex: Knex }) {
    super(deps, 'payments');
  }

  public insert = async (record: InsertPaymentRecord, trx?: Knex.Transaction) => {
    const [payment] = await this.query(trx).insert(record).returning('*');
    return payment;
  };

  public findById = async (id: string, trx?: Knex.Transaction) => {
    return this.query(trx).where({ id }).first();
  };
}
