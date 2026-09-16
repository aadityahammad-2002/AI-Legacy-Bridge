package com.legacybridge.storage.entity;

import jakarta.persistence.*;

import java.util.UUID;

@Entity
@Table(name = "imports")
public class ImportEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "repository_id", nullable = false)
    private UUID repositoryId;

    @Column(name = "source_file", nullable = false, columnDefinition = "text")
    private String sourceFile;

    @Column(name = "target_file", nullable = false, columnDefinition = "text")
    private String targetFile;

    public ImportEntity() {
    }

    public ImportEntity(UUID repositoryId, String sourceFile, String targetFile) {
        this.repositoryId = repositoryId;
        this.sourceFile = sourceFile;
        this.targetFile = targetFile;
    }

    public Long getId() {
        return id;
    }

    public UUID getRepositoryId() {
        return repositoryId;
    }

    public void setRepositoryId(UUID repositoryId) {
        this.repositoryId = repositoryId;
    }

    public String getSourceFile() {
        return sourceFile;
    }

    public void setSourceFile(String sourceFile) {
        this.sourceFile = sourceFile;
    }

    public String getTargetFile() {
        return targetFile;
    }

    public void setTargetFile(String targetFile) {
        this.targetFile = targetFile;
    }
}
