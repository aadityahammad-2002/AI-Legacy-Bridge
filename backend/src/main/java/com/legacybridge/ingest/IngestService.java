package com.legacybridge.ingest;

import com.legacybridge.ingest.dto.*;
import com.legacybridge.storage.entity.*;
import com.legacybridge.storage.repository.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

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
    private final AiServiceClient aiServiceClient;

    public IngestService(RepositoryEntityRepository repositoryRepository,
                          FileRepository fileRepository,
                          ClassRepository classRepository,
                          MethodRepository methodRepository,
                          ImportRepository importRepository,
                          DependencyRepository dependencyRepository,
                          GraphNodeRepository graphNodeRepository,
                          GraphEdgeRepository graphEdgeRepository,
                          AiServiceClient aiServiceClient) {
        this.repositoryRepository = repositoryRepository;
        this.fileRepository = fileRepository;
        this.classRepository = classRepository;
        this.methodRepository = methodRepository;
        this.importRepository = importRepository;
        this.dependencyRepository = dependencyRepository;
        this.graphNodeRepository = graphNodeRepository;
        this.graphEdgeRepository = graphEdgeRepository;
        this.aiServiceClient = aiServiceClient;
    }

    @Transactional
    public IngestResponse ingest(AnalysisIngestRequest request) {
        var repositoryId = request.repositoryId();

        // If this repositoryId was already ingested (e.g. a retried request),
        // replace it cleanly rather than duplicating rows.
        deleteExistingData(repositoryId);

        var repoEntity = new RepositoryEntity();
        repoEntity.setId(repositoryId);
        repoEntity.setName(request.repository().name());
        repoEntity.setSource(request.repository().source());
        repoEntity.setUrl(request.repository().url());
        repoEntity.setHealthScore(request.healthScore().score());
        repoEntity.setHealthGrade(request.healthScore().grade());
        repoEntity.setPatterns(request.patterns());
        repoEntity.setSecurityIssues(request.securityIssues());
        repoEntity.setDuplicates(request.duplicates());
        repositoryRepository.save(repoEntity);

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

        // The AI service (Python — see ai-service/README.md) re-queries
        // methods/classes/dependencies from Postgres itself, so it must not
        // be triggered until this transaction has actually committed —
        // otherwise its SELECT would run before these rows are visible.
        // afterCommit (not a direct call here) guarantees that ordering.
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                aiServiceClient.triggerIndexAsync(repositoryId);
            }
        });

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
        graphEdgeRepository.deleteAll(graphEdgeRepository.findByRepositoryId(repositoryId));
        graphNodeRepository.deleteAll(graphNodeRepository.findByRepositoryId(repositoryId));
        dependencyRepository.deleteAll(dependencyRepository.findByRepositoryId(repositoryId));
        importRepository.deleteAll(importRepository.findByRepositoryId(repositoryId));
        methodRepository.deleteAll(methodRepository.findByRepositoryId(repositoryId));
        classRepository.deleteAll(classRepository.findByRepositoryId(repositoryId));
        fileRepository.deleteAll(fileRepository.findByRepositoryId(repositoryId));
        repositoryRepository.findById(repositoryId).ifPresent(repositoryRepository::delete);
    }
}
