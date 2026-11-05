-- Existing repositories retain their current normalized data and created_at.
-- NULL analysis_snapshot means the repository predates lossless snapshot storage.
ALTER TABLE repositories
    ADD COLUMN IF NOT EXISTS analysis_snapshot JSONB;
ALTER TABLE repositories
    ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE repositories
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
