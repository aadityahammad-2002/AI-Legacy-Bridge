package com.legacybridge.sync;

import com.legacybridge.ingest.AiServiceClient;
import com.legacybridge.storage.repository.RepositoryEntityRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;
import static org.mockito.Mockito.*;

class AiSyncWorkerTest {
    private final AiSyncJobRepository jobs = mock(AiSyncJobRepository.class);
    private final AiServiceClient client = mock(AiServiceClient.class);
    private final RepositoryEntityRepository repos = mock(RepositoryEntityRepository.class);
    private final AiSyncWorker worker = new AiSyncWorker(jobs, client, repos, 180, 8);

    @Test
    void committedCurrentRevisionIndexesAndCompletes() {
        UUID repoId = UUID.randomUUID();
        var job = new AiSyncJobRepository.Job(UUID.randomUUID(), repoId, "INDEX", 7, 1, UUID.randomUUID());
        when(repos.findRevisionById(repoId)).thenReturn(Optional.of(7L));
        worker.process(job);
        verify(client).index(repoId);
        verify(jobs).complete(job);
        verify(jobs, never()).fail(any(), anyInt(), anyLong(), anyString());
    }

    @Test
    void missingRepositoryDoesNotGetReindexed() {
        UUID repoId = UUID.randomUUID();
        var job = new AiSyncJobRepository.Job(UUID.randomUUID(), repoId, "INDEX", 7, 1, UUID.randomUUID());
        when(repos.findRevisionById(repoId)).thenReturn(Optional.empty());
        worker.process(job);
        verifyNoInteractions(client);
        verify(jobs).complete(job);
    }

    @Test
    void supersededRevisionCannotClaimNewIndexing() {
        UUID repoId = UUID.randomUUID();
        var job = new AiSyncJobRepository.Job(UUID.randomUUID(), repoId, "INDEX", 3, 1, UUID.randomUUID());
        when(repos.findRevisionById(repoId)).thenReturn(Optional.of(4L));
        worker.process(job);
        verifyNoInteractions(client);
        verify(jobs).complete(job);
    }

    @Test
    void deletionCallsPythonCleanupAndCompletes() {
        UUID repoId = UUID.randomUUID();
        var job = new AiSyncJobRepository.Job(UUID.randomUUID(), repoId, "DELETE", 0, 1, UUID.randomUUID());
        when(repos.existsById(repoId)).thenReturn(false);
        worker.process(job);
        verify(client).deleteIndex(repoId);
        verify(jobs).complete(job);
    }

    @Test
    void pythonOfflineQueuesRetryWithoutFailingIngest() {
        UUID repoId = UUID.randomUUID();
        var job = new AiSyncJobRepository.Job(UUID.randomUUID(), repoId, "INDEX", 1, 2, UUID.randomUUID());
        when(repos.findRevisionById(repoId)).thenReturn(Optional.of(1L));
        doThrow(new IllegalStateException("offline")).when(client).index(repoId);
        worker.process(job);
        verify(jobs).fail(eq(job), eq(8), anyLong(), eq("IllegalStateException"));
        verify(jobs, never()).complete(job);
    }

    @Test
    void repeatedDeletionAfterRepositoryRecreatedDoesNotDeleteItsGraph() {
        UUID repoId = UUID.randomUUID();
        var job = new AiSyncJobRepository.Job(UUID.randomUUID(), repoId, "DELETE", 0, 1, UUID.randomUUID());
        when(repos.existsById(repoId)).thenReturn(true);
        worker.process(job);
        verifyNoInteractions(client);
        verify(jobs).complete(job);
    }
}
