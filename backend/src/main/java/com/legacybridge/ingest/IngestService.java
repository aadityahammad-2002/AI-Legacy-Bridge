package com.legacybridge.ingest;

import com.legacybridge.ingest.dto.*;
import com.legacybridge.storage.entity.*;
import com.legacybridge.storage.repository.*;
import org.springframework.stereotype.Service;
import org.springframework.jdbc.core.JdbcTemplate;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import com.legacybridge.sync.AiSyncJobRepository;

/**
 * Stores an already-completed analysis result (produced by the browser's
 * Analysis Engine — see orchestrator.js) into PostgreSQL. This service does
 * NOT parse or analyze source code itself; by the time a request reaches
 * here, all extraction has already happened client-side.
 *
 * Per PROJECT_DOCUMENTATION.md's repository-isolation rule, every row
 * written here is tagged with the request's repositoryId, and no method in
 * this class (or anywhere downstream) should ever read/write across
 * repositories.
 */
@Service
public class IngestService {

    private final RepositoryEntityRepository repositoryRepository;
    private final FileRepository fileRepository;
    private final ClassRepository classRepository;
    private final MethodRepository methodRepository;
    private final ImportRepository importRepository;
    private final DependencyRepository dependencyRepository;
    private final GraphNodeRepository graphNodeRepository;
    private final GraphEdgeRepository graphEdgeRepository;
    private final AiSyncJobRepository syncJobs;
    private final JdbcTemplate jdbcTemplate;

    public IngestService(RepositoryEntityRepository repositoryRepository,
                          FileRepository fileRepository,
                          ClassRepository classRepository,
                          MethodRepository methodRepository,
                          ImportRepository importRepository,
                          DependencyRepository dependencyRepository,
                          GraphNodeRepository graphNodeRepository,
                          GraphEdgeRepository graphEdgeRepository,
                          AiSyncJobRepository syncJobs,
                          JdbcTemplate jdbcTemplate) {
        this.repositoryRepository = repositoryRepository;
        this.fileRepository = fileRepository;
        this.classRepository = classRepository;
        this.methodRepository = methodRepository;
        this.importRepository = importRepository;
        this.dependencyRepository = dependencyRepository;
        this.graphNodeRepository = graphNodeRepository;
        this.graphEdgeRepository = graphEdgeRepository;
        this.syncJobs = syncJobs;
        this.jdbcTemplate = jdbcTemplate;
    }

    @Transactional
    public IngestResponse ingest(AnalysisIngestRequest request, JsonNode fullSnapshot) {
        var repositoryId = request.repositoryId();

        // Reject ambiguous path identities before any data is modified.
        // SQL UNIQUE(repository_id,path) would also reject them, but with a less
        // usable error and only after the transaction has started writing.
        Set<String> seenPaths = new HashSet<>();
        for (var file : request.files()) {
            if (!seenPaths.add(file.path())) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Duplicate source path: " + file.path());
            }
        }
        if (!Set.of("github", "zip", "local").contains(request.repository().source())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported repository source");
        }

        // Lock existing parent record; only its children are replaced. Deleting
        // the parent would also delete unrelated cascade rows and reset history.
        var existing = repositoryRepository.findByIdForUpdate(repositoryId);
        var repoEntity = existing.orElseGet(RepositoryEntity::new);
        if (existing.isPresent()) {
            deleteExistingData(repositoryId);
        }
        repoEntity.setRevision(repoEntity.getRevision() + 1);
        repoEntity.setUpdatedAt(Instant.now());
        repoEntity.setAnalysisSnapshot(fullSnapshot.deepCopy());
        repoEntity.setId(repositoryId);
        repoEntity.setName(request.repository().name());
        repoEntity.setSource(request.repository().source());
        repoEntity.setUrl(request.repository().url());
        repoEntity.setHealthScore(request.healthScore().score());
        repoEntity.setHealthGrade(request.healthScore().grade());
        repoEntity.setPatterns(request.patterns());
        repoEntity.setSecurityIssues(request.securityIssues());
        repoEntity.setDuplicates(request.duplicates());
        // Ensure the assigned-ID parent insert/update is flushed before
        // child-table IDENTITY inserts require its foreign-key row.
        repositoryRepository.saveAndFlush(repoEntity);

        var files = request.files().stream()
                .map(f -> new FileEntity(repositoryId, f.path(), f.language(), f.loc(), f.content()))
                .toList();
        fileRepository.saveAll(files);

        var classes = request.classes().stream()
                .map(c -> {
                    var entity = new ClassEntity();
                    entity.setRepositoryId(repositoryId);
                    entity.setName(c.name());
                    entity.setFilePath(c.file());
                    entity.setPackageName(c.packageName());
                    entity.setLine(c.line());
                    entity.setAnnotations(c.annotations());
                    return entity;
                })
                .toList();
        classRepository.saveAll(classes);

        var methods = request.functions().stream()
                .map(fn -> {
                    var entity = new MethodEntity();
                    entity.setRepositoryId(repositoryId);
                    entity.setName(fn.name());
                    entity.setFilePath(fn.file());
                    entity.setLine(fn.line());
                    entity.setEndLine(fn.endLine());
                    entity.setType(fn.type());
                    entity.setTopLevel(fn.isTopLevel());
                    entity.setExported(fn.isExported());
                    entity.setCode(fn.code());
                    return entity;
                })
                .toList();
        methodRepository.saveAll(methods);

        var imports = request.imports().stream()
                .map(i -> new ImportEntity(repositoryId, i.source(), i.target()))
                .toList();
        importRepository.saveAll(imports);

        var dependencies = request.dependencies().stream()
                .map(d -> new DependencyEntity(repositoryId, d.source(), d.target(),
                        d.type() != null ? d.type() : "import"))
                .toList();
        dependencyRepository.saveAll(dependencies);

        if (request.graph() != null) {
            if (request.graph().nodes() != null) {
                var nodes = request.graph().nodes().stream()
                        .map(n -> new GraphNodeEntity(repositoryId, n.id(), n.label()))
                        .toList();
                graphNodeRepository.saveAll(nodes);
            }
            if (request.graph().edges() != null) {
                var edges = request.graph().edges().stream()
                        .map(e -> new GraphEdgeEntity(repositoryId, e.source(), e.target()))
                        .toList();
                graphEdgeRepository.saveAll(edges);
            }
        }

        // Atomic outbox: the INDEX job exists iff this ingestion transaction commits.
        // The scheduled worker retries later if Python is down. No afterCommit
        // CompletableFuture and no lost indexing events on Java process crashes.
        syncJobs.enqueueIndex(repositoryId, repoEntity.getRevision());

        return new IngestResponse(
                repositoryId,
                files.size(),
                methods.size(),
                classes.size(),
                dependencies.size()
        );
    }

    /** Supports safe re-ingestion of the same repositoryId (e.g. client retry after a network error). */
    private void deleteExistingData(java.util.UUID repositoryId) {
        graphEdgeRepository.deleteByRepositoryIdInBulk(repositoryId);
        graphNodeRepository.deleteByRepositoryIdInBulk(repositoryId);
        dependencyRepository.deleteByRepositoryIdInBulk(repositoryId);
        importRepository.deleteByRepositoryIdInBulk(repositoryId);
        methodRepository.deleteByRepositoryIdInBulk(repositoryId);
        classRepository.deleteByRepositoryIdInBulk(repositoryId);
        fileRepository.deleteByRepositoryIdInBulk(repositoryId);
        // The previous implementation deleted the parent and PostgreSQL
        // cascaded into code_chunks. Preserve that behavior explicitly now
        // that the parent is retained: stale RAG chunks must not survive
        // a changed repository snapshot while Python reindexing is pending.
        jdbcTemplate.update("DELETE FROM code_chunks WHERE repository_id = ?", repositoryId);
    }
}
