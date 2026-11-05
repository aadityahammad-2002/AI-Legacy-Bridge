package com.legacybridge.ingest;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.legacybridge.ingest.dto.*;
import com.legacybridge.storage.entity.RepositoryEntity;
import com.legacybridge.storage.repository.*;
import com.legacybridge.sync.AiSyncJobRepository;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class IngestServiceReplacementTest {
    private final RepositoryEntityRepository repos = mock(RepositoryEntityRepository.class);
    private final FileRepository files = mock(FileRepository.class);
    private final ClassRepository classes = mock(ClassRepository.class);
    private final MethodRepository methods = mock(MethodRepository.class);
    private final ImportRepository imports = mock(ImportRepository.class);
    private final DependencyRepository dependencies = mock(DependencyRepository.class);
    private final GraphNodeRepository nodes = mock(GraphNodeRepository.class);
    private final GraphEdgeRepository edges = mock(GraphEdgeRepository.class);
    private final AiSyncJobRepository jobs = mock(AiSyncJobRepository.class);
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);

    private IngestService service() {
        return new IngestService(repos, files, classes, methods, imports,
                dependencies, nodes, edges, jobs, jdbc);
    }

    private AnalysisIngestRequest request(UUID id, List<FileDto> sourceFiles) {
        return new AnalysisIngestRequest(id, new RepositoryMetaDto("repo", "zip", null),
                sourceFiles, List.of(), List.of(), List.of(), List.of(),
                new GraphDto(List.of(), List.of()), List.of(), List.of(), List.of(),
                new HealthScoreDto(89, "B"));
    }

    @Test
    void duplicateSourcePathsRejectedWithoutDatabaseMutations() throws Exception {
        UUID id = UUID.randomUUID();
        var duplicate = new FileDto("src/a.py", "Python", 1, "print('x')");
        assertThrows(ResponseStatusException.class, () -> service().ingest(
                request(id, List.of(duplicate, duplicate)),
                new ObjectMapper().readTree("{\"repositoryId\":\"" + id + "\"}")));
        verifyNoInteractions(repos, files, classes, methods, imports, dependencies, nodes, edges, jobs, jdbc);
    }

    @Test
    void reingestPreservesParentIdentityAndCreatedAtButReplacesChildren() throws Exception {
        UUID id = UUID.randomUUID();
        var existing = new RepositoryEntity();
        existing.setId(id);
        existing.setRevision(4);
        Instant created = Instant.parse("2025-01-01T00:00:00Z");
        existing.setCreatedAt(created);
        when(repos.findByIdForUpdate(id)).thenReturn(Optional.of(existing));
        var snapshot = new ObjectMapper().readTree("{\"newAnalysisSection\":{\"x\":true}}");
            service().ingest(request(id, List.of(new FileDto("src/a.py", "Python", 1, "x=1"))), snapshot);
            assertEquals(id, existing.getId());
            assertEquals(created, existing.getCreatedAt());
            assertEquals(5, existing.getRevision());
            assertEquals(snapshot, existing.getAnalysisSnapshot());
            verify(repos).saveAndFlush(existing);
            verify(repos, never()).delete(any(RepositoryEntity.class));
            verify(files).deleteByRepositoryIdInBulk(id);
            verify(dependencies).deleteByRepositoryIdInBulk(id);
            verify(nodes).deleteByRepositoryIdInBulk(id);
            verify(edges).deleteByRepositoryIdInBulk(id);
            verify(jdbc).update("DELETE FROM code_chunks WHERE repository_id = ?", id);
            verify(jobs).enqueueIndex(id, 5);
    }
}
