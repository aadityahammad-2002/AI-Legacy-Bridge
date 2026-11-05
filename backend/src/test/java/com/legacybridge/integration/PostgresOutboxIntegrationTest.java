package com.legacybridge.integration;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.sql.DriverManager;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

/** Optional real-Postgres smoke test. MUST point at a disposable migrated test DB.
 * Skipped by default; never targets production via application.properties. */
class PostgresOutboxIntegrationTest {
    @Test
    @EnabledIfEnvironmentVariable(named = "LEGACYBRIDGE_TEST_DB_URL", matches = "jdbc:postgresql:.*")
    void v3OutboxSupportsAtomicInsertAndLeaseClaim() throws Exception {
        var url = System.getenv("LEGACYBRIDGE_TEST_DB_URL");
        var user = System.getenv("LEGACYBRIDGE_TEST_DB_USER");
        var password = System.getenv("LEGACYBRIDGE_TEST_DB_PASSWORD");
        assertNotNull(user, "Set LEGACYBRIDGE_TEST_DB_USER explicitly");
        assertNotNull(password, "Set LEGACYBRIDGE_TEST_DB_PASSWORD explicitly");
        assertTrue(url.contains("_test"), "Integration test database name must include _test");
        try (var connection = DriverManager.getConnection(url, user, password)) {
            connection.setAutoCommit(false);
            try {
                UUID repo = UUID.randomUUID();
                try (var ps = connection.prepareStatement("""
                    INSERT INTO ai_sync_jobs (repository_id, operation, repository_revision)
                    VALUES (?, 'INDEX', 1)
                    """)) {
                    ps.setObject(1, repo);
                    assertEquals(1, ps.executeUpdate());
                }
                try (var ps = connection.prepareStatement("""
                    WITH picked AS (
                        SELECT id FROM ai_sync_jobs WHERE repository_id = ?
                        LIMIT 1 FOR UPDATE SKIP LOCKED
                    )
                    UPDATE ai_sync_jobs j SET status = 'RUNNING', attempts = attempts + 1,
                        lease_token = gen_random_uuid(),
                        lease_until = now() + (180 * interval '1 second')
                    FROM picked WHERE j.id = picked.id
                    RETURNING j.status, j.attempts, j.lease_token
                    """)) {
                    ps.setObject(1, repo);
                    try (var rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals("RUNNING", rs.getString(1));
                        assertEquals(1, rs.getInt(2));
                        assertNotNull(rs.getObject(3));
                    }
                }
            } finally {
                connection.rollback();
            }
        }
    }
}
