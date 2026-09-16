package com.legacybridge.storage.entity;

import jakarta.persistence.*;

import java.util.UUID;

@Entity
@Table(name = "graph_edges")
public class GraphEdgeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "repository_id", nullable = false)
    private UUID repositoryId;

    @Column(name = "source_node_id", nullable = false, columnDefinition = "text")
    private String sourceNodeId;

    @Column(name = "target_node_id", nullable = false, columnDefinition = "text")
    private String targetNodeId;

    public GraphEdgeEntity() {
    }

    public GraphEdgeEntity(UUID repositoryId, String sourceNodeId, String targetNodeId) {
        this.repositoryId = repositoryId;
        this.sourceNodeId = sourceNodeId;
        this.targetNodeId = targetNodeId;
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

    public String getSourceNodeId() {
        return sourceNodeId;
    }

    public void setSourceNodeId(String sourceNodeId) {
        this.sourceNodeId = sourceNodeId;
    }

    public String getTargetNodeId() {
        return targetNodeId;
    }

    public void setTargetNodeId(String targetNodeId) {
        this.targetNodeId = targetNodeId;
    }
}
