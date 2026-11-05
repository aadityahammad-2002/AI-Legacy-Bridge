package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.ClassEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ClassRepository extends JpaRepository<ClassEntity, Long> {
    @Modifying
    @Query("delete from ClassEntity e where e.repositoryId = :repositoryId")
    int deleteByRepositoryIdInBulk(@Param("repositoryId") UUID repositoryId);

    List<ClassEntity> findByRepositoryId(UUID repositoryId);

    List<ClassEntity> findByRepositoryIdAndNameIn(UUID repositoryId, List<String> names);
}
