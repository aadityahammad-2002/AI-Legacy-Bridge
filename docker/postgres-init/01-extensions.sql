-- Executed only for a newly created Docker PostgreSQL data volume.
-- Flyway in the Java backend owns the actual application tables.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
