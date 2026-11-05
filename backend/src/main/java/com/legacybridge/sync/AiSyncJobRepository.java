package com.legacybridge.sync;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** PostgreSQL transactional outbox. Enqueue in the SAME transaction as repo ingest/delete. */
@Repository
public class AiSyncJobRepository {
    private final JdbcTemplate jdbc;

    public AiSyncJobRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public record Job(UUID id, UUID repositoryId, String operation, long revision, int attempts, UUID leaseToken) { }
    public record JobStatus(String operation, String status, long revision, int attempts,
                            String nextAttemptAt, String updatedAt) { }

    public void enqueueIndex(UUID repoId, long revision) {
        // Repository re-created under the same id: obsolete cleanup must not run.
        jdbc.update("""
            UPDATE ai_sync_jobs SET status = 'CANCELLED', lease_token = NULL,
                lease_until = NULL, updated_at = now()
            WHERE repository_id = ? AND operation = 'DELETE' AND status <> 'CANCELLED'
            """, repoId);
        jdbc.update("""
            INSERT INTO ai_sync_jobs (repository_id, operation, repository_revision)
            VALUES (?, 'INDEX', ?)
            ON CONFLICT (repository_id, operation) DO UPDATE SET
                repository_revision = EXCLUDED.repository_revision,
                status = 'PENDING', attempts = 0, next_attempt_at = now(),
                lease_until = NULL, lease_token = NULL, last_error = NULL, updated_at = now()
            """, repoId, revision);
    }

    public void enqueueDelete(UUID repoId) {
        // Prevent queued/leased old INDEX jobs from claiming completion after delete.
        jdbc.update("""
            UPDATE ai_sync_jobs SET status = 'CANCELLED', lease_token = NULL,
                lease_until = NULL, updated_at = now()
            WHERE repository_id = ? AND operation = 'INDEX' AND status <> 'CANCELLED'
            """, repoId);
        jdbc.update("""
            INSERT INTO ai_sync_jobs (repository_id, operation)
            VALUES (?, 'DELETE')
            ON CONFLICT (repository_id, operation) DO UPDATE SET
                status = 'PENDING', attempts = 0, next_attempt_at = now(),
                lease_until = NULL, lease_token = NULL, last_error = NULL, updated_at = now()
            """, repoId);
    }

    /** SKIP LOCKED enables multiple Java processes to poll without duplicate claims. */
    public List<Job> claim(int limit, int leaseSeconds) {
        return jdbc.query("""
            WITH picked AS (
                SELECT id FROM ai_sync_jobs
                WHERE ((status IN ('PENDING', 'RETRY') AND next_attempt_at <= now())
                    OR (status = 'RUNNING' AND lease_until < now()))
                ORDER BY next_attempt_at, created_at
                LIMIT ? FOR UPDATE SKIP LOCKED
            )
            UPDATE ai_sync_jobs j SET status = 'RUNNING',
                attempts = j.attempts + 1,
                lease_token = gen_random_uuid(),
                lease_until = now() + (? * interval '1 second'),
                updated_at = now()
            FROM picked WHERE j.id = picked.id
            RETURNING j.id, j.repository_id, j.operation, j.repository_revision,
                      j.attempts, j.lease_token
            """, (rs, row) -> toJob(rs), Math.max(1, Math.min(limit, 20)), Math.max(30, leaseSeconds));
    }

    private static Job toJob(ResultSet rs) throws SQLException {
        return new Job(rs.getObject("id", UUID.class),
                rs.getObject("repository_id", UUID.class), rs.getString("operation"),
                rs.getLong("repository_revision"), rs.getInt("attempts"),
                rs.getObject("lease_token", UUID.class));
    }

    public void complete(Job job) {
        jdbc.update("""
            UPDATE ai_sync_jobs SET status = 'SUCCEEDED', lease_token = NULL,
                lease_until = NULL, last_error = NULL, updated_at = now()
            WHERE id = ? AND lease_token = ? AND repository_revision = ? AND status = 'RUNNING'
            """, job.id(), job.leaseToken(), job.revision());
    }

    public void fail(Job job, int maxAttempts, long delaySeconds, String summary) {
        String safe = summary == null ? "AI service unavailable" : summary.replaceAll("[\\r\\n\\t]", " ");
        if (safe.length() > 240) safe = safe.substring(0, 240);
        jdbc.update("""
            UPDATE ai_sync_jobs SET
                status = CASE WHEN attempts >= ? THEN 'DEAD' ELSE 'RETRY' END,
                next_attempt_at = now() + (? * interval '1 second'),
                lease_token = NULL, lease_until = NULL, last_error = ?, updated_at = now()
            WHERE id = ? AND lease_token = ? AND repository_revision = ? AND status = 'RUNNING'
            """, Math.max(1, maxAttempts), delaySeconds, safe,
                job.id(), job.leaseToken(), job.revision());
    }

    /**
     * Explicit operator replay for an exhausted INDEX delivery, without re-ingesting data.
     * A single guarded SQL statement ensures the job is DEAD, the source repository still
     * exists, and the stored job revision matches its current revision. DELETE jobs are
     * deliberately never replayed by this operation.
     *
     * A concurrent repository update after this statement is safe: the worker re-checks
     * repository revision before dispatching and cannot index a deleted/stale revision.
     * Returns false when the job is absent, non-DEAD, deleted, or superseded.
     */
    public boolean replayDeadIndex(UUID repoId) {
        return jdbc.update("""
            UPDATE ai_sync_jobs j SET
                status = 'PENDING', attempts = 0, next_attempt_at = now(),
                lease_token = NULL, lease_until = NULL, last_error = NULL,
                updated_at = now()
            FROM repositories r
            WHERE j.repository_id = ?
              AND j.operation = 'INDEX'
              AND j.status = 'DEAD'
              AND r.id = j.repository_id
              AND r.revision = j.repository_revision
            """, repoId) == 1;
    }

    public Optional<JobStatus> status(UUID repoId) {
        List<JobStatus> result = jdbc.query("""
            SELECT operation, status, repository_revision, attempts,
                   next_attempt_at::text next_attempt_at, updated_at::text updated_at
            FROM ai_sync_jobs WHERE repository_id = ? AND operation = 'INDEX'
            """, (rs, row) -> new JobStatus(rs.getString("operation"), rs.getString("status"),
                rs.getLong("repository_revision"), rs.getInt("attempts"),
                rs.getString("next_attempt_at"), rs.getString("updated_at")), repoId);
        return result.stream().findFirst();
    }
}
