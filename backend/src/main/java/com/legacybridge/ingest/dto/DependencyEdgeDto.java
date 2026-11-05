package com.legacybridge.ingest.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;

/** Matches orchestrator.js's `imports[]` and `dependencies[]` entries. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record DependencyEdgeDto(
        @NotBlank String source,
        @NotBlank String target,
        String type
) {
}
