package com.legacybridge.storage.entity;

import jakarta.persistence.*;

import java.util.UUID;

@Entity
@Table(name = "dependencies")
public class DependencyEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "repository_id", nullable = false)
    private UUID repositoryId;

    @Column(nullable = false, columnDefinition = "text")
    private String source;

    @Column(nullable = false, columnDefinition = "text")
    private String target;

    @Column(nullable = false, length = 20)
    private String type = "import"; // 'import' | 'call'

    public DependencyEntity() {
    }

    public DependencyEntity(UUID repositoryId, String source, String target, String type) {
        this.repositoryId = repositoryId;
        this.source = source;
        this.target = target;
        this.type = type;
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

    public String getSource() {
        return source;
    }

    public void setSource(String source) {
        this.source = source;
    }

    public String getTarget() {
        return target;
    }

    public void setTarget(String target) {
        this.target = target;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }
}
