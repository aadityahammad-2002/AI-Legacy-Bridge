package com.legacybridge.ingest.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;

import java.util.List;

/**
 * Matches orchestrator.js's `classes[]` entries. Note: the JS field is named
 * "package" (extractClasses()'s output) — that's a reserved word in Java, so
 * it's mapped here to `packageName` via @JsonProperty.
 */
public record ClassDto(
        @NotBlank String name,
        @NotBlank String file,
        @JsonProperty("package") String packageName,
        Integer line,
        List<String> annotations
) {
}
