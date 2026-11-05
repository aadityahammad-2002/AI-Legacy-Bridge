package com.legacybridge.query;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.legacybridge.query.dto.RepositorySummaryDto;
import com.legacybridge.storage.repository.*;
import com.legacybridge.sync.AiSyncJobRepository;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RepositorySummaryProjectionTest {
    @Test
    void listUsesMetadataProjectionNotFullSnapshotSelect() {
        var repos = mock(RepositoryEntityRepository.class);
        var expected = new RepositorySummaryDto(UUID.randomUUID(), "repo", "zip", null,
                80, "B", Instant.now());
        when(repos.findRecentSummaries()).thenReturn(List.of(expected));
        var query = new RepositoryQueryService(repos,
                mock(FileRepository.class), mock(ClassRepository.class),
                mock(MethodRepository.class), mock(ImportRepository.class),
                mock(DependencyRepository.class), mock(GraphNodeRepository.class),
                mock(GraphEdgeRepository.class), new ObjectMapper(), mock(AiSyncJobRepository.class));
        assertEquals(List.of(expected), query.listRecent());
        verify(repos).findRecentSummaries();
        verify(repos, never()).findAll();
    }
}
