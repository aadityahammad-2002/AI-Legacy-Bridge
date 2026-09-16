package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.DependencyEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface DependencyRepository extends JpaRepository<DependencyEntity, Long> {
    List<DependencyEntity> findByRepositoryId(UUID repositoryId);

    List<DependencyEntity> findByRepositoryIdAndSource(UUID repositoryId, String source);

    List<DependencyEntity> findByRepositoryIdAndTarget(UUID repositoryId, String target);

    /**
     * Both directions at once (depends-on + used-by) for a given node — the
     * basis for the AI Explorer's Focused Mode context (see
     * PROJECT_DOCUMENTATION.md section 7: selected node + direct dependencies).
     */
    @Query("""
            SELECT d FROM DependencyEntity d
            WHERE d.repositoryId = :repositoryId
              AND (d.source = :nodeId OR d.target = :nodeId)
            """)
    List<DependencyEntity> findDirectConnections(@Param("repositoryId") UUID repositoryId,
                                                   @Param("nodeId") String nodeId);
}
