const assert = require('node:assert/strict');
const test = require('node:test');

const IdempotencyService = require('../../dist/services/idempotency/idempotency-service').default;

test('buildRequestHash returns the same hash for the same body with different key order', () => {
  const service = new IdempotencyService({ idempotencyDataAccess: {} });

  assert.equal(
    service.buildRequestHash({ a: 1, b: 2 }),
    service.buildRequestHash({ b: 2, a: 1 }),
  );
});

test('buildRequestHash recursively sorts nested object keys', () => {
  const service = new IdempotencyService({ idempotencyDataAccess: {} });

  assert.equal(
    service.buildRequestHash({ merchant: { id: 'm-1', country: 'TR' }, amount: 100 }),
    service.buildRequestHash({ amount: 100, merchant: { country: 'TR', id: 'm-1' } }),
  );
});

test('buildRequestHash changes when a value changes', () => {
  const service = new IdempotencyService({ idempotencyDataAccess: {} });

  assert.notEqual(
    service.buildRequestHash({ amountMinor: 1000, currency: 'TRY' }),
    service.buildRequestHash({ amountMinor: 1001, currency: 'TRY' }),
  );
});

test('buildRequestHash returns a lowercase SHA-256 hex string', () => {
  const service = new IdempotencyService({ idempotencyDataAccess: {} });
  const hash = service.buildRequestHash({ amountMinor: 1000, currency: 'TRY' });

  assert.match(hash, /^[a-f0-9]{64}$/);
});

test('starts a new idempotency record when scope and key are unseen', async () => {
  const calls = [];
  const service = new IdempotencyService({
    idempotencyDataAccess: {
      findByScopeAndKey: async () => null,
      tryInsertProcessing: async (record) => {
        calls.push(record);
        return { id: 'idem-1', ...record, status: 'PROCESSING' };
      },
    },
  });

  const result = await service.getExistingOrStart({
    scope: 'payments:create:merchant-1',
    idempotencyKey: 'idem-key-1',
    requestHash: 'hash-1',
  });

  assert.deepEqual(result, { type: 'STARTED', recordId: 'idem-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'payments:create:merchant-1');
  assert.equal(calls[0].idempotencyKey, 'idem-key-1');
  assert.equal(calls[0].requestHash, 'hash-1');
});

test('returns cached response for same scope, key, and request hash', async () => {
  const cachedBody = { id: 'payment-1', status: 'AUTHORIZED' };
  const service = new IdempotencyService({
    idempotencyDataAccess: {
      findByScopeAndKey: async () => ({
        id: 'idem-1',
        scope: 'payments:create:merchant-1',
        idempotency_key: 'idem-key-1',
        request_hash: 'hash-1',
        status: 'COMPLETED',
        response_status_code: 201,
        response_body: cachedBody,
      }),
      tryInsertProcessing: async () => {
        throw new Error('tryInsertProcessing should not be called for cached responses');
      },
    },
  });

  const result = await service.getExistingOrStart({
    scope: 'payments:create:merchant-1',
    idempotencyKey: 'idem-key-1',
    requestHash: 'hash-1',
  });

  assert.deepEqual(result, {
    type: 'COMPLETED',
    responseStatusCode: 201,
    responseBody: cachedBody,
  });
});

test('rejects same scope and key reused with a different request hash', async () => {
  const service = new IdempotencyService({
    idempotencyDataAccess: {
      findByScopeAndKey: async () => ({
        id: 'idem-1',
        request_hash: 'hash-1',
        status: 'COMPLETED',
      }),
      tryInsertProcessing: async () => {
        throw new Error('tryInsertProcessing should not be called for hash mismatch');
      },
    },
  });

  await assert.rejects(
    () =>
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-2',
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
      return true;
    },
  );
});

test('rejects duplicate request while the original request is still processing', async () => {
  const service = new IdempotencyService({
    idempotencyDataAccess: {
      findByScopeAndKey: async () => ({
        id: 'idem-1',
        request_hash: 'hash-1',
        status: 'PROCESSING',
      }),
      tryInsertProcessing: async () => {
        throw new Error('tryInsertProcessing should not be called for processing records');
      },
    },
  });

  await assert.rejects(
    () =>
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-1',
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'IDEMPOTENCY_REQUEST_IN_PROGRESS');
      return true;
    },
  );
});

test('reactivates a failed idempotency record only when the request hash matches', async () => {
  const service = new IdempotencyService({
    idempotencyDataAccess: {
      findByScopeAndKey: async () => ({
        id: 'idem-1',
        request_hash: 'hash-1',
        status: 'FAILED',
      }),
      tryInsertProcessing: async () => {
        throw new Error('tryInsertProcessing should not be called for failed existing records');
      },
      reactivateFailed: async (id, requestHash) => {
        assert.equal(id, 'idem-1');
        assert.equal(requestHash, 'hash-1');
        return { id: 'idem-1', request_hash: 'hash-1', status: 'PROCESSING' };
      },
    },
  });

  const result = await service.getExistingOrStart({
    scope: 'payments:create:merchant-1',
    idempotencyKey: 'idem-key-1',
    requestHash: 'hash-1',
  });

  assert.deepEqual(result, { type: 'STARTED', recordId: 'idem-1' });
});

test('rejects a failed idempotency record when the request hash is different', async () => {
  const service = new IdempotencyService({
    idempotencyDataAccess: {
      findByScopeAndKey: async () => ({
        id: 'idem-1',
        request_hash: 'hash-1',
        status: 'FAILED',
      }),
      tryInsertProcessing: async () => {
        throw new Error('tryInsertProcessing should not be called for failed existing records');
      },
      reactivateFailed: async () => {
        throw new Error('reactivateFailed should not be called for hash mismatch');
      },
    },
  });

  await assert.rejects(
    () =>
      service.getExistingOrStart({
        scope: 'payments:create:merchant-1',
        idempotencyKey: 'idem-key-1',
        requestHash: 'hash-2',
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
      return true;
    },
  );
});
