package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.FileEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface FileRepository extends JpaRepository<FileEntity, Long> {
    List<FileEntity> findByRepositoryId(UUID repositoryId);

    Optional<FileEntity> findByRepositoryIdAndPath(UUID repositoryId, String path);

    List<FileEntity> findByRepositoryIdOrderByPath(UUID repositoryId);
    // NEW — for filename-mentioned-in-question matching
    List<FileEntity> findByRepositoryIdAndPathEndingWithIgnoreCase(UUID repositoryId, String suffix);
}