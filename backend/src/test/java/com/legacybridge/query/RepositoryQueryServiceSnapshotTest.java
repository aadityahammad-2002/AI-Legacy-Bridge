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

class RepositoryQueryServiceSnapshotTest {
    @Test
    void reopeningReturnsExactlyStoredAnalysisInsteadOfLossyReconstruction() throws Exception {
        UUID id = UUID.randomUUID();
        var mapper = new ObjectMapper();
        var snapshot = mapper.readTree("""
                {"repositoryId":"ignored","repository":{"name":"x"},
                 "analysisCoverage":{"status":"partial"},
                 "advancedAnalysis":{"deep":{"value":42}},
                 "files":[{"path":"a.js","content":"const x = 1;"}]}
                """);
        var repo = new RepositoryEntity();
        repo.setId(id);
        repo.setAnalysisSnapshot(snapshot);
        var repos = mock(RepositoryEntityRepository.class);
        when(repos.findById(id)).thenReturn(Optional.of(repo));
        var query = new RepositoryQueryService(repos,
                mock(FileRepository.class), mock(ClassRepository.class),
                mock(MethodRepository.class), mock(ImportRepository.class),
                mock(DependencyRepository.class), mock(GraphNodeRepository.class),
                mock(GraphEdgeRepository.class), mapper, mock(AiSyncJobRepository.class));
        assertEquals(snapshot, query.getStoredAnalysis(id).orElseThrow());
        assertEquals(42, query.getStoredAnalysis(id).orElseThrow().at("/advancedAnalysis/deep/value").asInt());
    }

}
