package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.GraphEdgeEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface GraphEdgeRepository extends JpaRepository<GraphEdgeEntity, Long> {
    List<GraphEdgeEntity> findByRepositoryId(UUID repositoryId);
}
