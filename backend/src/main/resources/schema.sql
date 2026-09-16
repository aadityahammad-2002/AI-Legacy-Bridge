-- =============================================================================
-- AI Legacy Bridge — PostgreSQL Schema
-- =============================================================================
-- Every table below carries a repository_id and is NEVER queried without
-- filtering by it (see PROJECT_DOCUMENTATION.md, section 5, "Critical rule —
-- repository isolation"). repository_id is generated client-side
-- (crypto.randomUUID(), see frontend/src/session/session.js) at the moment a
-- new analysis run starts, so it's the same ID the frontend uses to tag its
-- IndexedDB Live Analysis Model snapshot and every AI Explorer request.
--
-- Requires the pgvector extension for code_chunks.embedding (RAG).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- -----------------------------------------------------------------------------
-- repositories — one row per analyzed repository/session
-- -----------------------------------------------------------------------------
CREATE TABLE repositories (
    id              UUID PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    source          VARCHAR(20)  NOT NULL CHECK (source IN ('github', 'zip', 'local')),
    url             TEXT,
    health_score    INTEGER,
    health_grade    VARCHAR(2),
    -- Loosely-structured analysis output that doesn't need to be queried
    -- relationally (pattern/security/duplicate reports) is kept as JSONB
    -- rather than fully normalized — see orchestrator.js's output shape.
    patterns        JSONB DEFAULT '[]'::jsonb,
    security_issues JSONB DEFAULT '[]'::jsonb,
    duplicates      JSONB DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- files
--
-- `content` stores the complete raw source of each file (Task 6 in
-- DEVELOPMENT_PROGRESS.md: the AI must have access to real source code, not
-- just extracted function snippets — this reverses the earlier Entry 6
-- decision to keep whole-file content backend-side-out, which was correct
-- for function-level RAG chunking alone but not for this requirement).
-- Nullable because repositories ingested before this column existed (or
-- re-ingested from cached local data without content) won't have it.
-- -----------------------------------------------------------------------------
CREATE TABLE files (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    language        VARCHAR(30),
    loc             INTEGER,
    content         TEXT,
    UNIQUE (repository_id, path)
);
CREATE INDEX idx_files_repository ON files(repository_id);

-- -----------------------------------------------------------------------------
-- classes
-- -----------------------------------------------------------------------------
CREATE TABLE classes (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    file_path       TEXT NOT NULL,
    package_name    VARCHAR(500),
    line            INTEGER,
    annotations     JSONB DEFAULT '[]'::jsonb
);
CREATE INDEX idx_classes_repository ON classes(repository_id);
CREATE INDEX idx_classes_repo_name ON classes(repository_id, name);

-- -----------------------------------------------------------------------------
-- methods (orchestrator calls these "functions" — one row per
-- extracted function/method, top-level or class member)
-- -----------------------------------------------------------------------------
CREATE TABLE methods (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    file_path       TEXT NOT NULL,
    line            INTEGER,
    end_line        INTEGER,
    type            VARCHAR(30), -- e.g. 'method', 'function', 'arrow', 'constructor'
    is_top_level    BOOLEAN NOT NULL DEFAULT false,
    is_exported     BOOLEAN NOT NULL DEFAULT false,
    code            TEXT
);
CREATE INDEX idx_methods_repository ON methods(repository_id);
CREATE INDEX idx_methods_repo_file ON methods(repository_id, file_path);

-- -----------------------------------------------------------------------------
-- imports — subset of `dependencies` where type = 'import' (kept as its own
-- table since the ingest DTO and DB schema originally specified it separately;
-- see PROJECT_DOCUMENTATION.md storage package list)
-- -----------------------------------------------------------------------------
CREATE TABLE imports (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_file     TEXT NOT NULL,
    target_file     TEXT NOT NULL
);
CREATE INDEX idx_imports_repository ON imports(repository_id);

-- -----------------------------------------------------------------------------
-- dependencies — full dependency graph edges (imports + call-graph, once
-- call-graph resolution is wired into orchestrator.js — see DEVELOPMENT_PROGRESS.md)
-- -----------------------------------------------------------------------------
CREATE TABLE dependencies (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source          TEXT NOT NULL,
    target          TEXT NOT NULL,
    type            VARCHAR(20) NOT NULL DEFAULT 'import' -- 'import' | 'call'
);
CREATE INDEX idx_dependencies_repository ON dependencies(repository_id);
CREATE INDEX idx_dependencies_source ON dependencies(repository_id, source);
CREATE INDEX idx_dependencies_target ON dependencies(repository_id, target);

-- -----------------------------------------------------------------------------
-- graph_nodes / graph_edges — the exact node/edge set the Visualization
-- Explorer's graph renders (kept separate from `dependencies` because the
-- graph view may collapse/group nodes differently than the raw dependency list)
-- -----------------------------------------------------------------------------
CREATE TABLE graph_nodes (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    node_id         TEXT NOT NULL, -- matches a files.path
    label           VARCHAR(255)
);
CREATE INDEX idx_graph_nodes_repository ON graph_nodes(repository_id);

CREATE TABLE graph_edges (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_node_id  TEXT NOT NULL,
    target_node_id  TEXT NOT NULL
);
CREATE INDEX idx_graph_edges_repository ON graph_edges(repository_id);

-- -----------------------------------------------------------------------------
-- code_chunks — RAG store. Populated by the ChunkingService/EmbeddingService
-- pipeline (not by IngestService directly) right after a repository is ingested.
-- Embedding dimension below (384) matches a typical local sentence-embedding
-- model (e.g. all-MiniLM-L6-v2); adjust to match whichever local model is used.
-- -----------------------------------------------------------------------------
CREATE TABLE code_chunks (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    class_name      VARCHAR(255),
    function_name   VARCHAR(255),
    content         TEXT NOT NULL,
    embedding       vector(384),
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_code_chunks_repository ON code_chunks(repository_id);
-- IVFFlat index for approximate nearest-neighbor search, scoped per-repository
-- queries still filter by repository_id first via the WHERE clause.
CREATE INDEX idx_code_chunks_embedding ON code_chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- -----------------------------------------------------------------------------
-- profile — a single row representing "this local instance's account" for
-- the Settings > Profile screen. No auth/login exists yet (deliberately
-- scoped out — see frontend/src/pages/SettingsPage.jsx), so this is not
-- tied to a session; it's whichever name/email/role was last saved from the
-- Settings screen. id is always 1 — enforced by the CHECK constraint so a
-- second row can never be inserted by mistake.
-- -----------------------------------------------------------------------------
CREATE TABLE profile (
    id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    name       VARCHAR(255) NOT NULL DEFAULT '',
    email      VARCHAR(255) NOT NULL DEFAULT '',
    role       VARCHAR(20)  NOT NULL DEFAULT 'Admin' CHECK (role IN ('Admin', 'Member', 'Read-only')),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
INSERT INTO profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- team_members — the Settings > Team access list. This is workspace-wide,
-- not per-repository (matches the "shared backend" deployment tier decided
-- for AI Legacy Bridge — see product discussion). No auth/session exists
-- yet, so this table is a membership + role list only; it does not gate any
-- endpoint (every endpoint remains open, as noted in backend/README.md).
-- -----------------------------------------------------------------------------
CREATE TABLE team_members (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      VARCHAR(255) NOT NULL UNIQUE,
    role       VARCHAR(20)  NOT NULL DEFAULT 'Member' CHECK (role IN ('Admin', 'Member', 'Read-only')),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

