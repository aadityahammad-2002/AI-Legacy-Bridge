package com.legacybridge.ingest.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * `content` is the file's complete raw source (Task 6 — see schema.sql's
 * note on the `files.content` column). Optional/nullable: older clients or
 * cached local-only snapshots may not send it.
 */
public record FileDto(
        @NotBlank String path,
        String language,
        Integer loc,
        String content
) {
}
