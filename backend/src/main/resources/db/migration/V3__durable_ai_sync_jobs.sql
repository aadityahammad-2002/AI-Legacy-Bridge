-- V3: durable Java -> Python indexing/deletion requests.
-- No FK to repositories: DELETE cleanup must outlive the deleted repository.
CREATE TABLE ai_sync_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID NOT NULL,
    operation VARCHAR(8) NOT NULL CHECK (operation IN ('INDEX', 'DELETE')),
    repository_revision BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(12) NOT NULL DEFAULT 'PENDING'
       CHECK (status IN ('PENDING', 'RUNNING', 'RETRY', 'SUCCEEDED', 'DEAD', 'CANCELLED')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until TIMESTAMPTZ,
    lease_token UUID,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(repository_id, operation)
);
CREATE INDEX idx_ai_sync_jobs_ready ON ai_sync_jobs (next_attempt_at, updated_at)
  WHERE status IN ('PENDING', 'RETRY', 'RUNNING');
