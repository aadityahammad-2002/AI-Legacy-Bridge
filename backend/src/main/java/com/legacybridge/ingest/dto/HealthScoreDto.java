package com.legacybridge.ingest.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public record HealthScoreDto(
        int score,
        String grade
) {
}
