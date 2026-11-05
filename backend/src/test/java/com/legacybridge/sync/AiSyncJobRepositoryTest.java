package com.legacybridge.sync;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.UUID;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class AiSyncJobRepositoryTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final AiSyncJobRepository jobs = new AiSyncJobRepository(jdbc);

    @Test
    void ingestionEnqueuesIdempotentRevisionScopedWork() {
        UUID id = UUID.randomUUID();
        jobs.enqueueIndex(id, 3);
        verify(jdbc).update(argThat((String sql) -> sql.contains("CANCELLED")), eq(id));
        verify(jdbc).update(argThat((String sql) -> sql.contains("ON CONFLICT")
                && sql.contains("repository_revision")), eq(id), eq(3L));
    }

    @Test
    void deletionCancelsIndexJobsAndPersistsCleanup() {
        UUID id = UUID.randomUUID();
        jobs.enqueueDelete(id);
        verify(jdbc).update(argThat((String sql) -> sql.contains("CANCELLED")), eq(id));
        verify(jdbc).update(argThat((String sql) -> sql.contains("'DELETE'")
                && sql.contains("ON CONFLICT")), eq(id));
    }

    @Test
    void replayOnlyAllowsDeadIndexWithMatchingLiveRepositoryRevision() {
        UUID id = UUID.randomUUID();
        when(jdbc.update(anyString(), eq(id))).thenReturn(1);
        org.junit.jupiter.api.Assertions.assertTrue(jobs.replayDeadIndex(id));
        verify(jdbc).update(argThat((String sql) ->
                sql.contains("j.operation = 'INDEX'") &&
                sql.contains("j.status = 'DEAD'") &&
                sql.contains("FROM repositories r") &&
                sql.contains("r.revision = j.repository_revision") &&
                sql.contains("attempts = 0") &&
                sql.contains("lease_token = NULL")), eq(id));
    }

    @Test
    void replayRejectsMissingStaleOrAlreadyProcessedJob() {
        UUID id = UUID.randomUUID();
        when(jdbc.update(anyString(), eq(id))).thenReturn(0);
        org.junit.jupiter.api.Assertions.assertFalse(jobs.replayDeadIndex(id));
    }

    @Test
    void completionRequiresCurrentLeaseAndRevision() {
        var j = new AiSyncJobRepository.Job(UUID.randomUUID(), UUID.randomUUID(),
                "INDEX", 2, 1, UUID.randomUUID());
        jobs.complete(j);
        verify(jdbc).update(argThat((String sql) -> sql.contains("lease_token = ?")
                && sql.contains("repository_revision = ?")), eq(j.id()), eq(j.leaseToken()), eq(2L));
    }
}
