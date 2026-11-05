package com.legacybridge.ingest.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;

/** Matches orchestrator.js's `functions[]` entries. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record FunctionDto(
        @NotBlank String name,
        @NotBlank String file,
        Integer line,
        Integer endLine,
        String type,
        boolean isTopLevel,
        boolean isExported,
        String code
) {
}
