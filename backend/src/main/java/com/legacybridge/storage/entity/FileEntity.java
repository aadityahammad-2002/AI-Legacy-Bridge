package com.legacybridge.storage.entity;

import jakarta.persistence.*;

import java.util.UUID;

@Entity
@Table(name = "files")
public class FileEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "repository_id", nullable = false)
    private UUID repositoryId;

    @Column(nullable = false, columnDefinition = "text")
    private String path;

    private String language;

    private Integer loc;

    @Column(columnDefinition = "text")
    private String content;

    public FileEntity() {
    }

    public FileEntity(UUID repositoryId, String path, String language, Integer loc, String content) {
        this.repositoryId = repositoryId;
        this.path = path;
        this.language = language;
        this.loc = loc;
        this.content = content;
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

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public String getLanguage() {
        return language;
    }

    public void setLanguage(String language) {
        this.language = language;
    }

    public Integer getLoc() {
        return loc;
    }

    public void setLoc(Integer loc) {
        this.loc = loc;
    }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }
}
