package com.legacybridge.storage.entity;

import jakarta.persistence.*;
import com.fasterxml.jackson.databind.JsonNode;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "repositories")
public class RepositoryEntity {

    @Id
    private UUID id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false, length = 20)
    private String source; // 'github' | 'zip' | 'local'

    private String url;

    @Column(name = "health_score")
    private Integer healthScore;

    @Column(name = "health_grade", length = 2)
    private String healthGrade;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<Map<String, Object>> patterns;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "security_issues", columnDefinition = "jsonb")
    private List<Map<String, Object>> securityIssues;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<Map<String, Object>> duplicates;

    /** Exact JSON request from the Analysis Engine, including currently-unknown sections.
     * Not reconstructed from normalized tables: full round-trip fidelity matters. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "analysis_snapshot", columnDefinition = "jsonb")
    private JsonNode analysisSnapshot;

    @Column(name = "revision", nullable = false)
    private long revision;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt = Instant.now();

    public RepositoryEntity() {
    }

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getSource() {
        return source;
    }

    public void setSource(String source) {
        this.source = source;
    }

    public String getUrl() {
        return url;
    }

    public void setUrl(String url) {
        this.url = url;
    }

    public Integer getHealthScore() {
        return healthScore;
    }

    public void setHealthScore(Integer healthScore) {
        this.healthScore = healthScore;
    }

    public String getHealthGrade() {
        return healthGrade;
    }

    public void setHealthGrade(String healthGrade) {
        this.healthGrade = healthGrade;
    }

    public List<Map<String, Object>> getPatterns() {
        return patterns;
    }

    public void setPatterns(List<Map<String, Object>> patterns) {
        this.patterns = patterns;
    }

    public List<Map<String, Object>> getSecurityIssues() {
        return securityIssues;
    }

    public void setSecurityIssues(List<Map<String, Object>> securityIssues) {
        this.securityIssues = securityIssues;
    }

    public List<Map<String, Object>> getDuplicates() {
        return duplicates;
    }

    public void setDuplicates(List<Map<String, Object>> duplicates) {
        this.duplicates = duplicates;
    }

    public JsonNode getAnalysisSnapshot() {
        return analysisSnapshot;
    }

    public void setAnalysisSnapshot(JsonNode analysisSnapshot) {
        this.analysisSnapshot = analysisSnapshot;
    }

    public long getRevision() {
        return revision;
    }

    public void setRevision(long revision) {
        this.revision = revision;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Instant updatedAt) {
        this.updatedAt = updatedAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }
}
