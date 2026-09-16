package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.ImportEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface ImportRepository extends JpaRepository<ImportEntity, Long> {
    List<ImportEntity> findByRepositoryId(UUID repositoryId);
}
