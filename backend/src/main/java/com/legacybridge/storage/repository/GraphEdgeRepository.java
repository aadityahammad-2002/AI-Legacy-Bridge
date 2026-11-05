package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.GraphEdgeEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface GraphEdgeRepository extends JpaRepository<GraphEdgeEntity, Long> {
    @Modifying
    @Query("delete from GraphEdgeEntity e where e.repositoryId = :repositoryId")
    int deleteByRepositoryIdInBulk(@Param("repositoryId") UUID repositoryId);

    List<GraphEdgeEntity> findByRepositoryId(UUID repositoryId);
}
