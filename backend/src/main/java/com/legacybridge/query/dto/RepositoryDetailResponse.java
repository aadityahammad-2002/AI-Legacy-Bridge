package com.legacybridge.query.dto;

import com.legacybridge.ingest.dto.*;

import java.util.List;
import java.util.Map;

/**
 * Legacy reconstruction shape for repositories ingested before the complete
 * JSON snapshot migration. New repositories return their exact stored JSON
 * payload, including raw source content and all analysis sections.
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
