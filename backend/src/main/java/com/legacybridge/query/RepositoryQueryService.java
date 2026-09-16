package com.legacybridge.query;

import com.legacybridge.ingest.dto.*;
import com.legacybridge.query.dto.RepositoryDetailResponse;
import com.legacybridge.query.dto.RepositorySummaryDto;
import com.legacybridge.storage.repository.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Read-only queries over already-ingested repositories — powers the Upload
 * Page's "Recent Repositories" list and reopening a past repository without
 * re-analyzing it (see PROJECT_DOCUMENTATION.md section 10's note on future
 * multi-repository support, now built).
 */
@Service
public class RepositoryQueryService {

    private final RepositoryEntityRepository repositoryRepository;
    private final FileRepository fileRepository;
    private final ClassRepository classRepository;
    private final MethodRepository methodRepository;
    private final ImportRepository importRepository;
    private final DependencyRepository dependencyRepository;
    private final GraphNodeRepository graphNodeRepository;
    private final GraphEdgeRepository graphEdgeRepository;

    public RepositoryQueryService(RepositoryEntityRepository repositoryRepository,
                                   FileRepository fileRepository,
                                   ClassRepository classRepository,
                                   MethodRepository methodRepository,
                                   ImportRepository importRepository,
                                   DependencyRepository dependencyRepository,
                                   GraphNodeRepository graphNodeRepository,
                                   GraphEdgeRepository graphEdgeRepository) {
        this.repositoryRepository = repositoryRepository;
        this.fileRepository = fileRepository;
        this.classRepository = classRepository;
        this.methodRepository = methodRepository;
        this.importRepository = importRepository;
        this.dependencyRepository = dependencyRepository;
        this.graphNodeRepository = graphNodeRepository;
        this.graphEdgeRepository = graphEdgeRepository;
    }

    /** Most-recent-first list for the Upload Page. */
    public List<RepositorySummaryDto> listRecent() {
        return repositoryRepository.findAll().stream()
                .sorted((a, b) -> b.getCreatedAt().compareTo(a.getCreatedAt()))
                .map(r -> new RepositorySummaryDto(
                        r.getId(), r.getName(), r.getSource(), r.getUrl(),
                        r.getHealthScore(), r.getHealthGrade(), r.getCreatedAt()
                ))
                .toList();
    }

    public Optional<RepositoryDetailResponse> getDetail(UUID repositoryId) {
        return repositoryRepository.findById(repositoryId).map(repo -> {
            List<FileDto> files = fileRepository.findByRepositoryId(repositoryId).stream()
                    .map(f -> new FileDto(f.getPath(), f.getLanguage(), f.getLoc(), f.getContent()))
                    .toList();

            List<ClassDto> classes = classRepository.findByRepositoryId(repositoryId).stream()
                    .map(c -> new ClassDto(c.getName(), c.getFilePath(), c.getPackageName(), c.getLine(), c.getAnnotations()))
                    .toList();

            List<FunctionDto> functions = methodRepository.findByRepositoryId(repositoryId).stream()
                    .map(m -> new FunctionDto(m.getName(), m.getFilePath(), m.getLine(), m.getEndLine(),
                            m.getType(), m.isTopLevel(), m.isExported(), m.getCode()))
                    .toList();

            List<DependencyEdgeDto> imports = importRepository.findByRepositoryId(repositoryId).stream()
                    .map(i -> new DependencyEdgeDto(i.getSourceFile(), i.getTargetFile(), "import"))
                    .toList();

            List<DependencyEdgeDto> dependencies = dependencyRepository.findByRepositoryId(repositoryId).stream()
                    .map(d -> new DependencyEdgeDto(d.getSource(), d.getTarget(), d.getType()))
                    .toList();

            List<GraphDto.GraphNodeDto> nodes = graphNodeRepository.findByRepositoryId(repositoryId).stream()
                    .map(n -> new GraphDto.GraphNodeDto(n.getNodeId(), n.getLabel()))
                    .toList();

            List<GraphDto.GraphEdgeDto> edges = graphEdgeRepository.findByRepositoryId(repositoryId).stream()
                    .map(e -> new GraphDto.GraphEdgeDto(e.getSourceNodeId(), e.getTargetNodeId()))
                    .toList();

            return new RepositoryDetailResponse(
                    new RepositoryMetaDto(repo.getName(), repo.getSource(), repo.getUrl()),
                    files,
                    functions,
                    classes,
                    imports,
                    dependencies,
                    new GraphDto(nodes, edges),
                    repo.getPatterns(),
                    repo.getSecurityIssues(),
                    repo.getDuplicates(),
                    new HealthScoreDto(
                            repo.getHealthScore() != null ? repo.getHealthScore() : 0,
                            repo.getHealthGrade() != null ? repo.getHealthGrade() : "F"
                    )
            );
        });
    }

    /**
     * Deletes a repository. Relies on the FK `ON DELETE CASCADE` constraints
     * in schema.sql to remove every dependent row (files, classes, methods,
     * imports, dependencies, graph_nodes, graph_edges, code_chunks) — this
     * is a single-row delete, not a fan-out of per-table deletes.
     *
     * @return true if a repository was found and deleted, false if the ID didn't exist
     */
    @Transactional
    public boolean delete(UUID repositoryId) {
        if (!repositoryRepository.existsById(repositoryId)) {
            return false;
        }
        repositoryRepository.deleteById(repositoryId);
        return true;
    }
}
