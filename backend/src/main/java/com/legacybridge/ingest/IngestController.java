package com.legacybridge.ingest;

import com.legacybridge.ingest.dto.AnalysisIngestRequest;
import com.legacybridge.ingest.dto.IngestResponse;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.ConstraintViolationException;
import jakarta.validation.Validator;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The backend's one and only write path for repository analysis data. The
 * browser's Analysis Engine POSTs its complete result here exactly once per analysis run. This controller never
 * triggers any parsing/scanning itself — see PROJECT_DOCUMENTATION.md
 * section 5.
 */
@RestController
@RequestMapping("/api/repository")
public class IngestController {

    private final IngestService ingestService;
    private final ObjectMapper objectMapper;
    private final Validator validator;

    public IngestController(IngestService ingestService, ObjectMapper objectMapper, Validator validator) {
        this.ingestService = ingestService;
        this.objectMapper = objectMapper;
        this.validator = validator;
    }

    @PostMapping("/ingest")
    public ResponseEntity<IngestResponse> ingest(@RequestBody JsonNode originalJson)
            throws JsonProcessingException {
        if (originalJson == null || !originalJson.isObject()) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.BAD_REQUEST, "JSON object required");
        }
        // Deserialize known fields for normalized tables, but save the entire
        // unmodified JSON tree in analysis_snapshot, including unknown sections.
        AnalysisIngestRequest request = objectMapper.treeToValue(originalJson, AnalysisIngestRequest.class);
        var violations = validator.validate(request);
        if (!violations.isEmpty()) {
            throw new ConstraintViolationException(violations);
        }
        IngestResponse response = ingestService.ingest(request, originalJson);
        return ResponseEntity.ok(response);
    }
}
