package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.MethodEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface MethodRepository extends JpaRepository<MethodEntity, Long> {
    @Modifying
    @Query("delete from MethodEntity e where e.repositoryId = :repositoryId")
    int deleteByRepositoryIdInBulk(@Param("repositoryId") UUID repositoryId);

    List<MethodEntity> findByRepositoryId(UUID repositoryId);

    List<MethodEntity> findByRepositoryIdAndFilePath(UUID repositoryId, String filePath);
}
