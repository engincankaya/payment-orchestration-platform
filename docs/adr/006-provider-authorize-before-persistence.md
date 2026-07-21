# ADR 006 — Provider authorize runs before payment persistence

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

## Consequences

- Retries are safe against providers that deduplicate on the payment
  reference. The mock provider does not deduplicate, which is acceptable in
  development.
- A residual double-authorization window remains for providers without
  reference-based idempotency. Reconciliation (Phase 7) is the detection net.
- Before integrating a real provider, one of the following must be done and
  this ADR superseded:
  - verify the provider deduplicates on our payment reference and document it,
    or
  - implement the PENDING-first / provider-attempt model so provider calls are
    recoverable after a crash.
- Phase 4 (capture) must apply the same stable-reference rule to capture
  operations.

## References

- Spec 17.5 (payment create flow MVP trade-off)
- Roadmap Phase 3.5 decisions: stable provider reference, lease takeover and
  FAILED reactivation preserving `resource_id`
- `services/payment-service/src/services/payments/payments-service.ts`
- `services/payment-service/src/services/idempotency/idempotency-service.ts`
