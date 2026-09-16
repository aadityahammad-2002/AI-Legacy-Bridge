package com.legacybridge.ingest.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Root shape of the POST /api/repository/ingest payload. Field names and
 * nesting mirror frontend/src/analysis-engine/orchestrator.js's return value
 * exactly — do not rename fields here without updating the frontend, and
 * vice versa.
 *
 * `repositoryId` is generated client-side (crypto.randomUUID(), see
 * frontend/src/session/session.js) BEFORE this request is sent, so it's the
 * same ID already used as the IndexedDB Live Analysis Model snapshot key.
 * The backend must use this ID as-is (not generate its own) so the frontend
 * session and the backend's stored data always refer to the same repository.
 *
 * @JsonIgnoreProperties(ignoreUnknown = true): the frontend's Live Analysis
 * Model (what UploadPage.jsx sends here via `{ repositoryId, ...analysisResult }`)
 * carries extra fields the backend doesn't need — call-graph data, computed
 * issues, per-file layer/complexity, language stats — used only by
 * Visualization Explorer directly from the browser. Without this annotation,
 * Jackson's default strict deserialization would reject the whole request
 * the moment the frontend added any such field, which is exactly what
 * happened when call-graph/issues/language-stats support was added — fixed
 * here rather than trying to keep this DTO in lockstep with every frontend-only field.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record AnalysisIngestRequest(
        @NotNull UUID repositoryId,
        @NotNull @Valid RepositoryMetaDto repository,
        @NotNull List<FileDto> files,
        @NotNull List<FunctionDto> functions,
        @NotNull List<ClassDto> classes,
        @NotNull List<DependencyEdgeDto> imports,
        @NotNull List<DependencyEdgeDto> dependencies,
        @NotNull GraphDto graph,
        List<Map<String, Object>> patterns,
        List<Map<String, Object>> securityIssues,
        List<Map<String, Object>> duplicates,
        @NotNull HealthScoreDto healthScore
) {
}
