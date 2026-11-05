# AI Legacy Bridge — Java Spring Boot backend

Java 21 · Spring Boot 3.3.4 · PostgreSQL / pgvector

The Java service is the repository storage owner. The **browser Analysis Engine** analyzes code;
Java stores its source and computed results; the separate **Python FastAPI AI Service** runs
RAG, indexing and agents. Java does not parse code or host the LLM.

## Current API contract

| Endpoint | Purpose |
| --- | --- |
| `POST /api/repository/ingest` | Receives an Analysis Engine result plus `repositoryId` |
| `GET /api/repository/{id}` | Reopens the exact ingested JSON snapshot when available |
| `GET /api/repository/list` | Returns repository metadata without loading large snapshots |
| `DELETE /api/repository/{id}` | Deletes a repository and its database-dependent rows |

Ingest persists the **complete received JSON document** in `repositories.analysis_snapshot` (JSONB),
including all current and future Analysis Engine sections and `files[].content`, without
flattening unknown sections away. Normalized `files`, `functions` (stored as `methods`),
`classes`, `dependencies`, `imports`, and graph tables remain for existing Python/indexing
queries. Reopening a pre-migration repository (where `analysis_snapshot` is NULL) still uses
the legacy reconstruction path, which contains fewer fields; it cannot retroactively
recover fields that were never stored.

Reingestion locks an existing repository row, updates the record in place, replaces its
normalized child rows in one transaction, increments `revision`, and preserves `created_at`.
An insert race involving a brand-new repository ID may produce HTTP 409; retry using the
same ID after confirming whether the first request committed. The existing post-commit
Python index trigger is **still fire-and-forget**, not a durable queue; see limitations below.

## PostgreSQL / Flyway migration

**Before enabling Flyway on an existing database, create and verify a database backup.**
Do not run `schema.sql` repeatedly against an existing environment. The migration scripts
are the source of truth going forward.

* `db/migration/V1__initial_repository_schema.sql` is the original schema and bootstraps a fresh database.
* `db/migration/V2__lossless_analysis_snapshots.sql` adds `analysis_snapshot`, `revision`,
  and `updated_at` to existing `repositories` without deleting historical rows.
* `spring.flyway.baseline-on-migrate=true` marks already-initialized nonempty schemas at
  version 1, then runs V2. **Verify the old schema is complete** before doing so;
  Flyway cannot infer whether manually managed schema is missing objects.
* `schema.sql` remains for archival/manual bootstrap reference, with new columns reflected;
  `spring.sql.init.mode=never` prevents auto-running it on startup.
* PostgreSQL needs `pgcrypto` and `vector` extensions. Create them as a privileged DBA
  if the runtime database role cannot run `CREATE EXTENSION`.

Configure datasource credentials using `SPRING_DATASOURCE_URL`,
`SPRING_DATASOURCE_USERNAME`, `SPRING_DATASOURCE_PASSWORD` (or an external properties
file). Never commit a real database password. For local development,
`legacybridge.ai-service.base-url` defaults to `http://localhost:8001` and CORS to
`http://localhost:5173`.

From `backend/` (requires Java 21 and Maven):

```powershell
mvn clean test
mvn -DskipTests package
mvn spring-boot:run
```

After startup, ingest one repository and `GET /api/repository/{id}`. Verify nested analysis
fields and source contents are unchanged, then reingest it and verify that repository IDs
and `created_at` remain stable and normalized child rows are not duplicated.

## Scope and remaining limitations

This phase strengthens **persistence, reopening, validation, migrations, and metadata-list
querying**. It does **not** implement authentication, authorization, profile or team APIs;
those are explicitly out of scope. Do not expose this unauthenticated service to the open
Internet or untrusted clients.

Not yet addressed: durable/retryable Python indexing, distributed idempotency for
concurrent first-time ingestion, chat sessions, async graph cleanup, comprehensive load
benchmarks, full production security hardening, and PostgreSQL integration testing.
These will require separate acceptance testing before production deployment.

The CI-style JUnit/Mockito regression tests live under `src/test/java`. In environments
without Maven dependencies, Java syntax-only parsing is possible, but it is **not**
equivalent to `mvn test` or a live PostgreSQL migration/round-trip test.
