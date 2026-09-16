package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.MethodEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface MethodRepository extends JpaRepository<MethodEntity, Long> {
    List<MethodEntity> findByRepositoryId(UUID repositoryId);

    List<MethodEntity> findByRepositoryIdAndFilePath(UUID repositoryId, String filePath);
}
