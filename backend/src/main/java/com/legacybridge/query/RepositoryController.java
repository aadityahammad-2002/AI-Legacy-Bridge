package com.legacybridge.query;

import com.fasterxml.jackson.databind.JsonNode;
import com.legacybridge.query.dto.RepositorySummaryDto;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.RequestParam;
import com.legacybridge.sync.AiSyncJobRepository;

@RestController
@RequestMapping("/api/repository")
public class RepositoryController {

    private final RepositoryQueryService queryService;
    private final AiSyncJobRepository syncJobs;

    public RepositoryController(RepositoryQueryService queryService, AiSyncJobRepository syncJobs) {
        this.queryService = queryService;
        this.syncJobs = syncJobs;
    }

    /** Powers the Upload Page's "Recent Repositories" list. */
    @GetMapping("/list")
    public List<RepositorySummaryDto> list() {
        return queryService.listRecent();
    }

    @GetMapping("/list/page")
    public org.springframework.data.domain.Page<RepositorySummaryDto> listPage(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size) {
        return queryService.listRecentPage(page, size);
    }

    @GetMapping("/{id}/index-status")
    public ResponseEntity<AiSyncJobRepository.JobStatus> indexStatus(@PathVariable UUID id) {
        return syncJobs.status(id).map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Reconstructs a full analysis result for a previously-ingested
     * repository, so it can be reopened without re-analyzing (see
     * PROJECT_DOCUMENTATION.md section 10). Returns 404 if the ID doesn't
     * exist (e.g. it was only ever a local IndexedDB snapshot whose ingest
     * failed — see UploadPage.jsx's ingestError handling).
     */
    @GetMapping("/{id}")
    public ResponseEntity<JsonNode> getDetail(@PathVariable UUID id) {
        return queryService.getStoredAnalysis(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Deletes a repository and its PostgreSQL children atomically, while
     * persisting an asynchronous Python/Neo4j cleanup job. Every child
     * table (files, classes, methods, imports, dependencies, graph_nodes,
     * graph_edges, code_chunks) has `REFERENCES repositories(id) ON DELETE
     * CASCADE` in schema.sql, so a single delete on the parent row is
     * enough for PostgreSQL; Neo4j is cleaned up by the retryable worker.
     */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable UUID id) {
        boolean deleted = queryService.delete(id);
        return deleted ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}
