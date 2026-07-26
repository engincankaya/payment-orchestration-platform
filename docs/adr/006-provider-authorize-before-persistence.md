# ADR 006 — Provider side effects before durable completion

## Status

Accepted (2026-07-21) — **pre-production blocker**: must be revisited before any
real payment provider (PayTR, Iyzico, Stripe, ...) is integrated.

## Context

In the payment create flow, `PaymentsService.create` calls
`provider.authorize()` **before** the payment row is inserted, and the insert
plus the idempotency `COMPLETED` write happen together in one DB transaction
afterwards. This ordering is the MVP trade-off allowed by spec section 17.5.

The failure mode it leaves open:

1. Provider authorization **succeeds** (money is reserved on the card).
2. The DB insert or idempotency update **fails** (outage, timeout, deploy).
3. The idempotency record is marked `FAILED` and may be retried with the same
   idempotency key.
4. The retry calls `provider.authorize()` **again** — a second authorization
   for the same logical payment.

The alternative — a full PENDING-first flow (persist payment as `PENDING`,
call the provider, then finalize status in a second step, with an attempt
model and recovery for in-doubt attempts) — was considered and deliberately
not implemented in Phase 3.5. It changes the transaction layout that Phase 4
(capture + transactional outbox) will build on, and the current provider is a
mock, so the residual risk today is zero.

Capture has the same durable-completion gap. Phase 4 serializes different-key
capture requests by locking the payment row with `SELECT ... FOR UPDATE` and
running `provider.capture()` while that transaction is open. The lock prevents
two concurrent requests from calling the provider for the same AUTHORIZED
payment, but it cannot recover an external side effect when the process dies
after provider success and before the DB transaction commits.

## Decision

Keep authorize-before-persist for the MVP, and narrow the double-authorization
window with a **stable provider reference**:

- A payment id is reserved when the idempotency record is created
  (`idempotency_keys.resource_id`, written at `PROCESSING` insert time).
- `FAILED` reactivation and expired-lease takeover **preserve** that
  `resource_id`; they never mint a new one.
- `PaymentsService` uses the reserved id as the `paymentId` sent to the
  provider, so every retry of the same idempotency key presents the **same
  payment reference** to the provider.

This lets any real provider that supports reference-based idempotency
deduplicate retries. It does not, by itself, prevent double authorization
against a provider that ignores the reference.

Phase 4 applies the same stable-reference rule to capture:

- Capture idempotency is scoped by payment id.
- The captured payment id is the provider-facing reference and the
  idempotency record's `resource_id`.
- Different idempotency keys for one payment are serialized by a payment row
  lock, with a conditional status update retained as the final DB guard.
- `provider.capture()` executes while the DB transaction and payment row lock
  are open.

The row lock solves concurrent execution only. A crash after a successful
provider call and before commit leaves the idempotency record PROCESSING; lease
takeover may later call the provider again with the same payment reference.

Phase 4 also adds database ownership fencing for lease takeover. Every
PROCESSING acquisition receives a new `processing_token`; takeover and FAILED
reactivation rotate it. `markCompleted` and `markFailed` update only the
matching PROCESSING record and token. A pre-takeover owner therefore receives
`IDEMPOTENCY_OWNERSHIP_LOST`, and a stale completion rolls back its
payment/outbox transaction instead of overwriting the new owner's state.

This token fences durable database completion only. It is not sent to or
enforced by the provider, so it cannot undo or deduplicate a provider side
effect that happened before ownership was lost.

## Consequences

- Retries are safe against providers that deduplicate on the payment
  reference. The mock provider does not deduplicate, which is acceptable in
  development.
- Lease takeover cannot let an old owner commit stale
  payment/outbox/idempotency state after the new owner acquires its processing
  token.
- A residual double-authorization window remains for providers without
  reference-based idempotency. Reconciliation (Phase 7) is the detection net.
- A residual double-capture window remains across crash/retry unless the
  provider deduplicates the stable payment reference or a durable attempt model
  is introduced.
- Holding the payment row lock during the provider call increases DB
  transaction duration. A competing request can wait longer than Gateway's
  default 5000 ms payment-service timeout and receive 504 even while the first
  capture is still progressing.
- A Gateway timeout does not prove capture failure. Callers retry only with the
  same idempotency key and must accept replay/in-progress semantics.
- Before integrating a real provider, one of the following must be done and
  this ADR superseded:
  - verify the provider deduplicates on our payment reference and document it,
    or
  - implement the PENDING-first / provider-attempt model so provider calls are
    recoverable after a crash.

## References

- Spec 17.5 (payment create flow MVP trade-off)
- Spec 17.3 (idempotency processing-token ownership fencing)
- Spec 17.6 (capture locking, idempotency and crash-retry trade-off)
- Roadmap Phase 4 decisions
- Roadmap Phase 3.5 decisions: stable provider reference, lease takeover and
  FAILED reactivation preserving `resource_id`
- `services/payment-service/src/services/payments/payments-service.ts`
- `services/payment-service/src/services/idempotency/idempotency-service.ts`
