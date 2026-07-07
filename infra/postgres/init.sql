-- Local development bootstrap only.
-- This file creates one database per database-owning service when the local
-- Postgres container starts with an empty data directory.
-- It is not a schema migration file. Service-owned tables and indexes must be
-- created through each service's Knex migrations.

CREATE DATABASE payment_db;
CREATE DATABASE ledger_db;
CREATE DATABASE webhook_db;
