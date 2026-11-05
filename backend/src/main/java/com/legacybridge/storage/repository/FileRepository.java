package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.FileEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface FileRepository extends JpaRepository<FileEntity, Long> {
    @Modifying
    @Query("delete from FileEntity e where e.repositoryId = :repositoryId")
    int deleteByRepositoryIdInBulk(@Param("repositoryId") UUID repositoryId);

    List<FileEntity> findByRepositoryId(UUID repositoryId);

    Optional<FileEntity> findByRepositoryIdAndPath(UUID repositoryId, String path);

    List<FileEntity> findByRepositoryIdOrderByPath(UUID repositoryId);
    // NEW — for filename-mentioned-in-question matching
    List<FileEntity> findByRepositoryIdAndPathEndingWithIgnoreCase(UUID repositoryId, String suffix);
}