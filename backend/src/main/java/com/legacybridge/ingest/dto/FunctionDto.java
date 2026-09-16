package com.legacybridge.ingest.dto;

import jakarta.validation.constraints.NotBlank;

/** Matches orchestrator.js's `functions[]` entries. */
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
