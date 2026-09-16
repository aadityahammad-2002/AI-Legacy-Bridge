package com.legacybridge.ingest.dto;

import jakarta.validation.constraints.NotBlank;

/** Matches orchestrator.js's `imports[]` and `dependencies[]` entries. */
public record DependencyEdgeDto(
        @NotBlank String source,
        @NotBlank String target,
        String type
) {
}
