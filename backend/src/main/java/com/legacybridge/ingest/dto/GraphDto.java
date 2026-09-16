package com.legacybridge.ingest.dto;

import java.util.List;

public record GraphDto(
        List<GraphNodeDto> nodes,
        List<GraphEdgeDto> edges
) {
    public record GraphNodeDto(String id, String label) {
    }

    public record GraphEdgeDto(String source, String target) {
    }
}
