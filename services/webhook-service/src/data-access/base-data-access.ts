import type { Knex } from 'knex';

import type { TransactionContext } from './transaction-manager';

export default abstract class BaseDataAccess<TRecord extends object> {
  protected knex: Knex;
  protected tableName: string;

  constructor(deps: { knex: Knex }, tableName: string) {
    this.knex = deps.knex;
    this.tableName = tableName;
  }

  protected query(trx?: TransactionContext) {
    const client = trx ?? this.knex;
    return client<TRecord>(this.tableName);
  }
}
