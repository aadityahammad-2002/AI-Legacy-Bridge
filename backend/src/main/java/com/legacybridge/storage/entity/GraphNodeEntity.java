package com.legacybridge.storage.entity;

import jakarta.persistence.*;

import java.util.UUID;

@Entity
@Table(name = "graph_nodes")
public class GraphNodeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "repository_id", nullable = false)
    private UUID repositoryId;

    @Column(name = "node_id", nullable = false, columnDefinition = "text")
    private String nodeId;

    private String label;

    public GraphNodeEntity() {
    }

    public GraphNodeEntity(UUID repositoryId, String nodeId, String label) {
        this.repositoryId = repositoryId;
        this.nodeId = nodeId;
        this.label = label;
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

    public String getNodeId() {
        return nodeId;
    }

    public void setNodeId(String nodeId) {
        this.nodeId = nodeId;
    }

    public String getLabel() {
        return label;
    }

    public void setLabel(String label) {
        this.label = label;
    }
}
