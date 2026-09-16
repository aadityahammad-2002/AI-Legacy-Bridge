package com.legacybridge.query;

import com.legacybridge.query.dto.RepositoryDetailResponse;
import com.legacybridge.query.dto.RepositorySummaryDto;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/repository")
public class RepositoryController {

    private final RepositoryQueryService queryService;

    public RepositoryController(RepositoryQueryService queryService) {
        this.queryService = queryService;
    }

    /** Powers the Upload Page's "Recent Repositories" list. */
    @GetMapping("/list")
    public List<RepositorySummaryDto> list() {
        return queryService.listRecent();
    }

    /**
     * Reconstructs a full analysis result for a previously-ingested
     * repository, so it can be reopened without re-analyzing (see
     * PROJECT_DOCUMENTATION.md section 10). Returns 404 if the ID doesn't
     * exist (e.g. it was only ever a local IndexedDB snapshot whose ingest
     * failed — see UploadPage.jsx's ingestError handling).
     */
    @GetMapping("/{id}")
    public ResponseEntity<RepositoryDetailResponse> getDetail(@PathVariable UUID id) {
        return queryService.getDetail(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Deletes a repository and everything derived from it. Every child
     * table (files, classes, methods, imports, dependencies, graph_nodes,
     * graph_edges, code_chunks) has `REFERENCES repositories(id) ON DELETE
     * CASCADE` in schema.sql, so a single delete on the parent row is
     * enough — no manual per-table cleanup needed here.
     */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable UUID id) {
        boolean deleted = queryService.delete(id);
        return deleted ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}
