package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.RepositoryEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;
import java.util.Optional;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import jakarta.persistence.LockModeType;
import com.legacybridge.query.dto.RepositorySummaryDto;

public interface RepositoryEntityRepository extends JpaRepository<RepositoryEntity, UUID> {

    /** Lock the parent row during re-ingest. Prevents concurrent replacement races
     * for an existing repositoryId without deleting its stable parent identity. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from RepositoryEntity r where r.id = :id")
    Optional<RepositoryEntity> findByIdForUpdate(@Param("id") UUID id);

    /** Fetch only revision, not the (potentially huge) JSONB snapshot. */
    @Query("select r.revision from RepositoryEntity r where r.id = :id")
    Optional<Long> findRevisionById(@Param("id") UUID id);

    /** Avoid loading multi-megabyte analysis_snapshot JSONB for the list endpoint. */
    @Query("select new com.legacybridge.query.dto.RepositorySummaryDto(" +
           "r.id, r.name, r.source, r.url, r.healthScore, r.healthGrade, r.createdAt) " +
           "from RepositoryEntity r order by r.createdAt desc")
    java.util.List<RepositorySummaryDto> findRecentSummaries();

    /** Bounded listing without allocating large analysis_snapshot JSONB values. */
    @Query("select new com.legacybridge.query.dto.RepositorySummaryDto(" +
           "r.id, r.name, r.source, r.url, r.healthScore, r.healthGrade, r.createdAt) " +
           "from RepositoryEntity r order by r.createdAt desc")
    org.springframework.data.domain.Page<RepositorySummaryDto> findRecentSummariesPage(
            org.springframework.data.domain.Pageable pageable);
}
