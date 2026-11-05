package com.legacybridge.query;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.legacybridge.storage.entity.RepositoryEntity;
import com.legacybridge.storage.repository.*;
import com.legacybridge.sync.AiSyncJobRepository;
import org.junit.jupiter.api.Test;
import java.util.Optional;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RepositoryDeletionOutboxTest {
    @Test
    void existingRepositoryRemovalEnqueuesDurableCleanup() {
        UUID id = UUID.randomUUID();
        var repo = new RepositoryEntity(); repo.setId(id);
        var repos = mock(RepositoryEntityRepository.class);
        var jobs = mock(AiSyncJobRepository.class);
        when(repos.findByIdForUpdate(id)).thenReturn(Optional.of(repo));
        var service = new RepositoryQueryService(repos,
                mock(FileRepository.class), mock(ClassRepository.class),
                mock(MethodRepository.class), mock(ImportRepository.class),
                mock(DependencyRepository.class), mock(GraphNodeRepository.class),
                mock(GraphEdgeRepository.class), new ObjectMapper(), jobs);
        assertTrue(service.delete(id));
        verify(repos).delete(repo);
        verify(repos).flush();
        verify(jobs).enqueueDelete(id);
    }
}
