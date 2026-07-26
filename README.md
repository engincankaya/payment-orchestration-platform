# Payment Orchestration Platform

![CI](https://github.com/engincankaya/payment-orchestration-platform/actions/workflows/ci.yml/badge.svg)

A TypeScript microservices platform that demonstrates **reliability engineering in a payment domain**: idempotent money movement, ownership-fenced processing leases, transactional outbox delivery, fail-closed security and contract-first HTTP/event APIs — built test-first, with the trade-offs documented as ADRs.

> This project intentionally uses only four services. The goal is not to create as many services as possible, but to demonstrate clear service boundaries, data ownership and reliability patterns in a payment domain.

**Status: in active development.** Payment create, authorize and capture flows, PostgreSQL-backed idempotency, transactional outbox persistence and RabbitMQ publishing are complete and tested. Ledger consumption and webhooks are on the [roadmap](#roadmap).

## Architecture

```mermaid
flowchart LR
    Client([Merchant client]) -->|HTTP + x-api-key| GW[API Gateway]
    GW -->|HTTP + x-internal-token| PS[Payment Service]

    PS --> PDB[(payment_db)]

    PS -->|transactional outbox + confirm publisher| MQ[[RabbitMQ]]
    MQ -.->|payment events, planned| LS[Ledger Service]
    LS -.-> LDB[(ledger_db)]
    GW -.->|balance reads, planned| LS

    Provider([Payment provider]) -.->|webhook, planned| WS[Webhook Service]
    WS -.->|normalized provider status, planned| PS
    WS -.-> WDB[(webhook_db)]
```

| Service | Responsibility | Owns |
| --- | --- | --- |
| **api-gateway** | Public API, API-key auth, request validation, routing to internal services. Never touches a database. | — |
| **payment-service** | Payment create/authorize/capture lifecycle, idempotency fencing, provider adapters and transactional outbox publishing. | `payment_db` |
| **ledger-service** | Append-only financial records and balances (planned). | `ledger_db` |
| **webhook-service** | Provider webhook verification, dedup and normalization (planned). | `webhook_db` |

Hard boundaries, enforced by architecture tests in CI:

- No shared domain or service runtime code — business logic, containers and service classes are deliberately duplicated per service. The only shared package is `openapi-kit`, an internal contract/documentation tool with no domain logic.
- Each service owns exactly one database; services never read each other's tables.
- Route → controller → service → data-access/client layering with constructor injection (Awilix).
- OpenAPI documents are **generated from route metadata + Joi schemas** — the runtime routes and the published contract cannot drift.

## Reliability & security engineering

The interesting parts, all covered by tests:

- **Idempotent payment operations** — every mutating request carries an `idempotency-key`. Create keys are scoped per merchant and capture keys per payment; request inputs are hashed, and replays return the original response (including its status code) without touching the provider. Reusing a key with a different request returns `409`.
- **Capture concurrency control** — capture replay is scoped per payment. A PostgreSQL row lock serializes different idempotency keys targeting the same payment, while a conditional status update provides a final database guard.
- **Crash-safe processing leases with ownership fencing** — an in-flight idempotency record holds a `processing_expires_at` lease and application-generated processing token. A retry can take over an expired record, but the old owner cannot commit stale payment, outbox or idempotency state.
- **Stable provider reference** — the payment id is reserved when the idempotency record is created and survives retries and lease takeovers, so a provider always sees the same reference for the same logical payment (double-charge mitigation; see [ADR 006](docs/adr/006-provider-authorize-before-persistence.md)).
- **Transactional outbox** — payment state, outbox event and idempotency completion are committed in one PostgreSQL transaction. A rollback cannot leave a successful payment transition without its event.
- **Reliable RabbitMQ publishing** — the outbox worker uses a singleton confirm channel, persistent messages, `mandatory: true`, `basic.return` handling, bounded confirm timeouts and reconnect/backoff. Delivery is explicitly at-least-once and preserves stable event/message identity.
- **Bounded shutdown** — the Payment Service stops new HTTP work, drains the outbox worker, closes RabbitMQ and Knex, and uses a hard-exit fallback when active HTTP or database work cannot settle within the configured grace.
- **Fail-closed configuration** — missing secrets (`INTERNAL_SERVICE_TOKEN`, `PUBLIC_API_KEY`) or invalid numeric config fail at boot, not silently at request time. Token comparisons are timing-safe.
- **Bounded outbound calls** — gateway→payment-service calls have timeouts (`504`/`502` mapping); GETs retry once on transport errors only; mutating POSTs never auto-retry.
- **Database integrity as a last line** — CHECK constraints on payment status, currency and positive amounts; `updated_at` maintained by triggers; amounts capped below the JS safe-integer precision boundary.
- **Closed by default** — Swagger UI requires `OPENAPI_DOCS_ENABLED=true`; CORS is off unless `CORS_ALLOWED_ORIGINS` is set; auth runs before validation so unauthenticated callers can't probe schemas.

## Getting started

Requires Docker and Node 20+.

```bash
npm ci

# start postgres, redis, rabbitmq and all four services
docker compose -f infra/docker-compose.yml up -d --build

# run payment-service migrations
docker compose -f infra/docker-compose.yml exec payment-service npm run migrate
```

Services start before migrations are applied; the payment endpoints need the migration step above before the first request. Automated migration ordering (deploy pipeline / one-off job) is a documented roadmap item.

Create and fetch a payment through the gateway:

```bash
curl -s -X POST http://localhost:8080/api/v1/payments \
  -H 'content-type: application/json' \
  -H 'x-api-key: local-public-api-key' \
  -H 'idempotency-key: demo-key-0001' \
  -d '{"merchantId":"11111111-1111-4111-8111-111111111111","amountMinor":1000,"currency":"TRY"}'

curl -s http://localhost:8080/api/v1/payments/<paymentId> \
  -H 'x-api-key: local-public-api-key'
```

Replay the same `POST` with the same key and body — you get the same payment back and the provider is not called twice. Change the body while keeping the key — you get `409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST`.

Capture the authorized payment with a new idempotency key:

```bash
curl -s -X POST http://localhost:8080/api/v1/payments/<paymentId>/capture \
  -H 'x-api-key: local-public-api-key' \
  -H 'idempotency-key: capture-demo-key-0001'
```

The local stack does not yet declare the Ledger Service queue/binding. Until it does, mandatory publishes receive `NO_ROUTE`, are recorded for retry and may become terminal `FAILED` after the configured attempts instead of being silently lost.

Interactive API docs (enabled in the dev compose file): http://localhost:8080/api-docs

### Key environment variables

| Variable | Purpose |
| --- | --- |
| `PUBLIC_API_KEY` | Gateway API key (boot-fails if missing) |
| `INTERNAL_SERVICE_TOKEN` | Service-to-service auth token (boot-fails if missing) |
| `PAYMENT_SERVICE_TIMEOUT_MS` | Gateway outbound timeout (default 5000) |
| `RABBITMQ_URL` | Payment Service RabbitMQ connection URL (required) |
| `IDEMPOTENCY_PROCESSING_LEASE_MS` | In-flight idempotency lease (default 60s) |
| `IDEMPOTENCY_COMPLETED_TTL_MS` / `IDEMPOTENCY_FAILED_TTL_MS` | Retention timestamps for finished records |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE` | Outbox polling interval and batch size (defaults: 1000 / 50) |
| `OUTBOX_MAX_ATTEMPTS` | Maximum attempted publishes before terminal failure (default 10) |
| `OUTBOX_RETRY_BASE_DELAY_MS` / `OUTBOX_RETRY_MAX_DELAY_MS` | Exponential retry bounds (defaults: 1000 / 60000) |
| `RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS` | Broker-confirm timeout (default 10000) |
| `OUTBOX_SHUTDOWN_GRACE_MS` | Worker and Payment Service shutdown grace (default 30000) |
| `OPENAPI_DOCS_ENABLED` | Swagger UI, off unless `"true"` |
| `CORS_ALLOWED_ORIGINS` | CORS whitelist, CORS disabled when unset |

## Testing

Built strictly test-first (red → green → refactor). Four layers:

| Layer | What it locks down | Run |
| --- | --- | --- |
| Architecture tests | Service boundaries, no shared runtime code, security guardrails (no wildcard CORS, timing-safe auth, amount ceiling) | `npm run test:architecture` |
| Unit tests | Domain rules: state transitions, idempotency fencing, outbox envelopes, publish/retry classification and lifecycle orchestration | `npm run test:unit` |
| HTTP tests | Real Express apps via supertest with container overrides — auth ordering, capture contracts, correlation IDs, CORS and docs gating | part of `test:unit` |
| Integration tests | Real PostgreSQL and RabbitMQ via testcontainers — migrations, row locks, atomicity, reconnect, mandatory returns and at-least-once duplicate delivery | `npm run test:integration` |

```bash
npm test                  # architecture + typecheck + unit/http
npm run test:integration  # requires Docker
```

CI (GitHub Actions) runs all of the above plus per-service Docker image builds.

## Intentionally out of scope (for now)

Documented deferrals, each with a tripwire for when it must be revisited:

- **Provider side-effect recovery** — authorization runs before persistence (MVP trade-off). Mitigated by the stable provider reference; must be revisited before integrating a real provider. [ADR 006](docs/adr/006-provider-authorize-before-persistence.md)
- **Merchant ownership & scope enforcement** — a single trusted API key exists today; merchant identity binding is a blocker before multi-merchant support. [ADR 007](docs/adr/007-merchant-ownership-deferred.md)
- **Ledger event consumption** — the Payment Service owns the exchange and publisher; the Ledger Service will own its durable queue, binding, dead-letter topology and idempotent consumer.
- Real provider adapters (PayTR/Iyzico/Stripe), rate limiting, circuit breakers, structured log shipping — tracked on the roadmap.

## Roadmap

**Delivered**

- Four-service skeleton with per-service Docker builds and CI
- Payment create/authorize flow through the gateway
- OpenAPI contracts generated from route metadata and Joi schemas
- PostgreSQL-backed idempotency with processing leases and stable provider references
- Reliability & security hardening: fail-closed config, timing-safe auth, outbound timeouts, database integrity constraints
- Payment capture with row locking and ownership fencing
- Transactional outbox with versioned JSON Schema event contracts
- Confirm-based RabbitMQ publishing with retries, reconnect and bounded shutdown

**Next**

- Ledger service: append-only financial records, balances, event consumption

**Planned**

- Webhook service: signature verification, deduplication, normalization
- Reconciliation inside the ledger
- End-to-end flows, cross-service shutdown consistency, readiness probes and remaining ADRs

## Architecture Decision Records

ADRs live in [`docs/adr/`](docs/adr/). Numbers 001–005 are reserved for foundational write-ups; 006+ record decisions made along the way.

## License

[MIT](LICENSE)
