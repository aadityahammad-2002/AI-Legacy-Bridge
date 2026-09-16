package com.legacybridge.query.dto;

import com.legacybridge.ingest.dto.*;

import java.util.List;
import java.util.Map;

/**
 * Reconstructs the same JSON shape orchestrator.js produces (see
 * AnalysisIngestRequest), so the frontend's Visualization Explorer can render
 * a reopened repository exactly like a freshly-analyzed one — with one
 * deliberate exception: there's no `fileContents`, since the backend never
 * stores whole-file source (see PROJECT_DOCUMENTATION.md section 8). The AI
 * Explorer's code editor already handles that being absent gracefully.
 */
public record RepositoryDetailResponse(
        RepositoryMetaDto repository,
        List<FileDto> files,
        List<FunctionDto> functions,
        List<ClassDto> classes,
        List<DependencyEdgeDto> imports,
        List<DependencyEdgeDto> dependencies,
        GraphDto graph,
        List<Map<String, Object>> patterns,
        List<Map<String, Object>> securityIssues,
        List<Map<String, Object>> duplicates,
        HealthScoreDto healthScore
) {
}
