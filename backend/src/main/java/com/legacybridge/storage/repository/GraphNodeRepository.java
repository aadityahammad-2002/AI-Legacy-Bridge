package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.GraphNodeEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface GraphNodeRepository extends JpaRepository<GraphNodeEntity, Long> {
    List<GraphNodeEntity> findByRepositoryId(UUID repositoryId);
}
