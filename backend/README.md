# legacy-bridge-backend

Spring Boot backend for AI Legacy Bridge. Per the project architecture, this
service **never parses or analyzes repositories itself** — it only stores
what the browser-side Analysis Engine already extracted, and (in later
stages, not yet built) runs the RAG pipeline and AI agents on top of that
stored data.

## ⚠️ Not compile-tested

This sandbox's network only allows npm/PyPI/crates.io/GitHub-related hosts —
Maven Central (`repo.maven.apache.org`) is blocked, so Maven can't download
Spring Boot's dependencies here, and this code has **not** been run through
`mvn compile` the way the frontend was verified with `vite build`. It was
written carefully against Spring Boot 3.3 / Java 21 / Hibernate 6 APIs, but
please run `mvn clean install` locally before trusting it, and report back
anything that doesn't compile so it can be fixed.

## Setup

1. PostgreSQL running locally with the `pgvector` extension available (e.g.
   the `pgvector/pgvector:pg16` Docker image, or `CREATE EXTENSION vector;`
   on a self-managed instance).
2. Create the database and user referenced in `application.properties`
   (`legacybridge` / `legacybridge` / `changeme` — change these for anything
   beyond local dev):
   ```sql
   CREATE DATABASE legacybridge;
   CREATE USER legacybridge WITH PASSWORD 'changeme';
   GRANT ALL PRIVILEGES ON DATABASE legacybridge TO legacybridge;
   ```
3. `schema.sql` runs automatically on startup (`spring.sql.init.mode=always`)
   — no separate migration step needed for this stage. Once the project has
   real data to protect, switch to Flyway/Liquibase instead of re-running
   `schema.sql` on every boot.
4. `mvn spring-boot:run`

## What's here

- `ingest/` — `POST /api/repository/ingest`, the single write path the
  browser's Analysis Engine posts its completed analysis to. Stores each
  file's complete raw source in `files.content` (see note below — this is
  what makes Task 6's "AI must have real source code" possible).
- `query/` — read-only endpoints for the Upload Page's Recent Repositories
  feature: `GET /api/repository/list`, `GET /api/repository/{id}` (reconstructs
  a full analysis result — including file content — from stored entities, so
  a repository can be reopened without re-analyzing), `DELETE /api/repository/{id}`
  (relies on `schema.sql`'s `ON DELETE CASCADE` — a single-row delete, not
  manual per-table cleanup).
- `storage/` — JPA entities + Spring Data repositories, one per table in
  `schema.sql`, all keyed by `repository_id`.
- `rag/` — the RAG pipeline, triggered automatically (async) right after a
  successful ingest:
  - `ChunkingService` — one chunk per function/method, splitting oversized
    ones with line overlap, tagged with class/import metadata.
  - `EmbeddingService` — interface with two implementations:
    - `HashingEmbeddingService` (**default**, active out of the box) — a
      deterministic feature-hashing embedding, no model download needed.
      Good enough to exercise the whole pipeline immediately; captures
      lexical similarity (shared identifiers/keywords) well, not deep
      semantic similarity.
    - `DjlLocalEmbeddingService` (**opt-in**, `legacybridge.embedding.provider=djl`)
      — a real local ONNX embedding model via DJL. This is the highest-risk,
      least-verified file in the backend — read its Javadoc before enabling it.
  - `CodeChunkRepository` — JDBC-based (not a JPA entity — see below) reads
    and writes for `code_chunks`, including the cosine-similarity search
    query `ai/ContextRetrievalService` uses.
  - `RagIndexingService` — orchestrates the above, runs `@Async` so ingest
    responses don't wait on embedding potentially thousands of functions.
- `ai/` — `POST /api/ai/ask`, the AI Explorer's single entry point:
  - `ContextRetrievalService` — combines (1) the **full source of whichever
    file is open in the editor** (fetched directly from `files.content`, not
    via RAG — always complete and current), (2) Focused Mode structural
    lookups (direct + second-level dependencies), (3) vector similarity
    search over `code_chunks`.
  - `AgentOrchestrator` — keyword-routes to one of 5 system prompts
    (Debug/Security/Migration/Risk/General), each told to treat the "PRIMARY
    FILE" context block as ground truth and never claim it lacks source code
    when that block is present.
  - `GroqClient` — final LLM call (OpenAI-compatible chat completions API).
- `config/` — CORS config so the Vite dev server (`http://localhost:5173`
  by default) can call the API.

**`files.content`:** every ingested file's complete raw source is stored.
This reverses an earlier design note that deliberately kept whole-file
content backend-side-out, from back when RAG chunking (function-level) was
the only consumer of stored data — the AI Explorer's "currently open file
becomes primary context" requirement needs the real source, not just
extracted chunks. Nullable, since repositories ingested before this column
existed won't have it retroactively.

**Why `code_chunks` isn't a JPA `@Entity`:** pgvector's `vector` column needs
either a custom Hibernate `UserType` or direct JDBC access via the
`pgvector-java` library's `PGvector` wrapper. The custom-Hibernate-type route
is a bigger unverified risk in an environment that can't compile-check this
code, so `CodeChunkRepository` uses `JdbcTemplate` + raw `PreparedStatement`
directly instead — more explicit, fewer places for a subtle mapping bug to hide.

## What's NOT here yet (see DEVELOPMENT_PROGRESS.md)

- Any authentication/authorization (currently fully open — fine for local
  dev, not for anything else).
- `DjlLocalEmbeddingService` has not been tested against a real model —
  see its Javadoc for exactly what's unverified.
- No conversation memory in AI Explorer — each question is answered
  independently.
- Sending full file content on every ingest means larger request payloads
  for big repositories — not yet measured against any real size limit.
