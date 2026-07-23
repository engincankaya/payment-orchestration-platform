import type { Knex } from 'knex';

import TransactionManager, {
  TransactionContext,
} from '../../src/data-access/transaction-manager';

describe('TransactionManager', () => {
  it('runs the handler through Knex and returns its result', async () => {
    const trx = { id: 'trx-1' } as unknown as TransactionContext;
    const handler = jest.fn().mockResolvedValue({ paymentId: 'payment-1' });
    const transaction = jest.fn(
      async <T>(transactionHandler: (context: TransactionContext) => Promise<T>) =>
        transactionHandler(trx),
    );
    const manager = new TransactionManager({
      knex: { transaction } as unknown as Knex,
    });

    await expect(manager.run(handler)).resolves.toEqual({ paymentId: 'payment-1' });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(trx);
  });

  it('does not swallow a handler failure', async () => {
    const trx = { id: 'trx-1' } as unknown as TransactionContext;
    const failure = new Error('transaction work failed');
    const transaction = jest.fn(
      async <T>(transactionHandler: (context: TransactionContext) => Promise<T>) =>
        transactionHandler(trx),
    );
    const manager = new TransactionManager({
      knex: { transaction } as unknown as Knex,
    });

    await expect(
      manager.run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
