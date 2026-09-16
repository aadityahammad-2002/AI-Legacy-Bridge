package com.legacybridge.ingest.dto;

import jakarta.validation.constraints.NotBlank;

/** Matches orchestrator.js's `repoMeta`: { name, source, url? } */
public record RepositoryMetaDto(
        @NotBlank String name,
        @NotBlank String source, // 'github' | 'zip' | 'local'
        String url
) {
}
