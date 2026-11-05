package com.legacybridge.ingest.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.NotBlank;

@JsonIgnoreProperties(ignoreUnknown = true)
public record GraphDto(
        List<@NotNull @Valid GraphNodeDto> nodes,
        List<@NotNull @Valid GraphEdgeDto> edges
) {
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record GraphNodeDto(@NotBlank String id, String label) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record GraphEdgeDto(@NotBlank String source, @NotBlank String target) {
    }
}
