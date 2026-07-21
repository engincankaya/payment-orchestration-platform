# ADR 007 — Merchant ownership and scope enforcement are deferred

## Status

Accepted (2026-07-21) — **blocker**: must be implemented before more than one
merchant or API key is supported, and before any non-development exposure.

## Context

The gateway authenticates callers with a single static `PUBLIC_API_KEY`. The
authenticated principal (`res.locals.auth` with `apiKeyId` and `scopes`) is
produced by the auth middleware but is **not used** anywhere downstream:

- `merchantId` is taken from the **request body** on create; any
  authenticated caller can create payments for any merchant.
- `GET /payments/:paymentId` has no ownership filter; any authenticated
  caller can read any payment whose UUID it knows (IDOR).
- `scopes` (`payments:create`, `payments:read`) are attached but never
  enforced per route.

With exactly one trusted API key in a development environment, all callers
are equally privileged, so these gaps have no exploitable difference today.

We explicitly decided **not** to pin the current behavior with a
characterization test: a green test asserting "any key can read any
merchant's payment" would read as an endorsed contract rather than a known
gap. This ADR is the single durable record instead.

## Decision

Defer merchant identity binding and scope enforcement in the MVP. Keep all
auth logic behind the existing abstractions (`ExternalAuthService`,
`ApiKeyAuthProvider`, auth middleware) so the production model can replace
the static key without touching controllers or domain services.

The production model, when implemented, must:

1. Derive merchant identity from the authenticated principal (API key →
   merchant mapping); `merchantId` must never be accepted from the request
   body.
2. Filter `getById` (and any future read) by the caller's merchant scope so
   cross-tenant reads return 404.
3. Enforce `scopes` per route in middleware.

Implementation starts with RED tests for these three behaviors; those tests
replace this ADR's deferral.

## Consequences

- The current API fully trusts every authenticated caller. This is acceptable
  only while the single development key exists and the gateway is not
  exposed beyond local/dev environments.
- Adding a second merchant or API key without implementing the production
  model is a security regression, not a feature increment — this ADR is the
  tripwire.
- Roadmap Phase 3.5 records the same constraint; spec section 28 (Security
  Rules) and the authentication extension boundary (roadmap future-proofing
  12.2) describe the target model.

## References

- `services/api-gateway/src/services/auth/api-key-auth-provider.ts`
- `services/api-gateway/src/server/controllers/payments/payments-controller.ts`
- `services/payment-service/src/services/payments/payments-service.ts` (`getById`)
- Roadmap Phase 3.5 decisions; roadmap 12.2 Authentication Extension Boundary
