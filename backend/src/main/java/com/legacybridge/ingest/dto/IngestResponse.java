package com.legacybridge.ingest.dto;

import java.util.UUID;

public record IngestResponse(
        UUID repositoryId,
        int filesStored,
        int functionsStored,
        int classesStored,
        int dependenciesStored
) {
}
