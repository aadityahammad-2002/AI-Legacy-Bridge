package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.ImportEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ImportRepository extends JpaRepository<ImportEntity, Long> {
    @Modifying
    @Query("delete from ImportEntity e where e.repositoryId = :repositoryId")
    int deleteByRepositoryIdInBulk(@Param("repositoryId") UUID repositoryId);

    List<ImportEntity> findByRepositoryId(UUID repositoryId);
}
