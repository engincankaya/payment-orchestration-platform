import type { Knex } from 'knex';

export type TransactionContext = Knex.Transaction;

export interface TransactionManagerPort {
  /** Runs the handler within a database transaction. */
  run<T>(handler: (trx: TransactionContext) => Promise<T>): Promise<T>;
}

export default class TransactionManager implements TransactionManagerPort {
  private readonly knex: Knex;

  constructor(deps: { knex: Knex }) {
    this.knex = deps.knex;
  }

  public run = async <T>(
    handler: (trx: TransactionContext) => Promise<T>,
  ): Promise<T> => {
    return this.knex.transaction(handler);
  };
}
