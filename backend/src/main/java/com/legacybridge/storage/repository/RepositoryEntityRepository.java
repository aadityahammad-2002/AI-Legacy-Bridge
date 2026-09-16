package com.legacybridge.storage.repository;

import com.legacybridge.storage.entity.RepositoryEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface RepositoryEntityRepository extends JpaRepository<RepositoryEntity, UUID> {
}
