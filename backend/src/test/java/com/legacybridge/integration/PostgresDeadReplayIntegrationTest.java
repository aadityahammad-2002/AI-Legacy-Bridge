package com.legacybridge.integration;

import com.legacybridge.sync.AiSyncJobRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

import java.sql.DriverManager;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/** Requires an explicitly configured disposable PostgreSQL *_test database.
 * Every database write is rolled back, including the temporary repository row.
 * Never reads the application's normal datasource configuration. */
class PostgresDeadReplayIntegrationTest {
    @Test
    @EnabledIfEnvironmentVariable(named = "LEGACYBRIDGE_TEST_DB_URL", matches = "jdbc:postgresql:.*")
    void replaysOnlyDeadIndexWithExactLiveRevisionAndRollsBack() throws Exception {
        String url = System.getenv("LEGACYBRIDGE_TEST_DB_URL");
        String user = System.getenv("LEGACYBRIDGE_TEST_DB_USER");
        String password = System.getenv("LEGACYBRIDGE_TEST_DB_PASSWORD");
        assertNotNull(user, "Set LEGACYBRIDGE_TEST_DB_USER explicitly");
        assertNotNull(password, "Set LEGACYBRIDGE_TEST_DB_PASSWORD explicitly");
        assertTrue(url.contains("_test"), "Refusing to run on non-test database");

        try (var connection = DriverManager.getConnection(url, user, password)) {
            connection.setAutoCommit(false);
            try {
                UUID repoId = UUID.randomUUID();
                try (var insertRepo = connection.prepareStatement("""
                        INSERT INTO repositories (id, name, source, revision)
                        VALUES (?, 'TEST_REPLAY_DISPOSABLE', 'local', 1)
                        """)) {
                    insertRepo.setObject(1, repoId);
                    assertEquals(1, insertRepo.executeUpdate());
                }
                try (var insertJob = connection.prepareStatement("""
                        INSERT INTO ai_sync_jobs
                            (repository_id, operation, repository_revision, status, attempts)
                        VALUES (?, 'INDEX', 1, 'DEAD', 8)
                        """)) {
                    insertJob.setObject(1, repoId);
                    assertEquals(1, insertJob.executeUpdate());
                }

                var jobs = new AiSyncJobRepository(
                        new JdbcTemplate(new SingleConnectionDataSource(connection, true)));
                assertTrue(jobs.replayDeadIndex(repoId));
                try (var check = connection.prepareStatement("""
                        SELECT status, attempts, lease_token, lease_until
                        FROM ai_sync_jobs WHERE repository_id = ? AND operation = 'INDEX'
                        """)) {
                    check.setObject(1, repoId);
                    try (var rows = check.executeQuery()) {
                        assertTrue(rows.next());
                        assertEquals("PENDING", rows.getString(1));
                        assertEquals(0, rows.getInt(2));
                        assertNull(rows.getObject(3));
                        assertNull(rows.getObject(4));
                    }
                }
                assertFalse(jobs.replayDeadIndex(repoId), "Cannot replay a non-DEAD job");

                try (var markDead = connection.prepareStatement("""
                        UPDATE ai_sync_jobs SET status='DEAD', attempts=8
                        WHERE repository_id = ? AND operation='INDEX'
                        """)) {
                    markDead.setObject(1, repoId);
                    assertEquals(1, markDead.executeUpdate());
                }
                try (var changeRevision = connection.prepareStatement("""
                        UPDATE repositories SET revision=2 WHERE id = ?
                        """)) {
                    changeRevision.setObject(1, repoId);
                    assertEquals(1, changeRevision.executeUpdate());
                }
                assertFalse(jobs.replayDeadIndex(repoId), "Cannot replay a stale INDEX revision");

                try (var deleteRepo = connection.prepareStatement("DELETE FROM repositories WHERE id = ?")) {
                    deleteRepo.setObject(1, repoId);
                    assertEquals(1, deleteRepo.executeUpdate());
                }
                assertFalse(jobs.replayDeadIndex(repoId), "Cannot replay a deleted repository");
            } finally {
                connection.rollback();
            }
        }
    }
}
