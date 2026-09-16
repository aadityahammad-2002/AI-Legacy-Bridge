package com.legacybridge.query.dto;

import java.time.Instant;
import java.util.UUID;

/** One row in the Upload Page's "Recent Repositories" list. */
public record RepositorySummaryDto(
        UUID id,
        String name,
        String source,
        String url,
        Integer healthScore,
        String healthGrade,
        Instant createdAt
) {
}
