package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.ClassEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface ClassRepository extends JpaRepository<ClassEntity, Long> {
    List<ClassEntity> findByRepositoryId(UUID repositoryId);

    List<ClassEntity> findByRepositoryIdAndNameIn(UUID repositoryId, List<String> names);
}
