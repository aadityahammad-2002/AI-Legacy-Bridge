package com.legacybridge.ingest;

import com.legacybridge.ingest.dto.AnalysisIngestRequest;
import com.legacybridge.ingest.dto.IngestResponse;
import jakarta.validation.Valid;
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

    public IngestController(IngestService ingestService) {
        this.ingestService = ingestService;
    }

    @PostMapping("/ingest")
    public ResponseEntity<IngestResponse> ingest(@Valid @RequestBody AnalysisIngestRequest request) {
        IngestResponse response = ingestService.ingest(request);
        return ResponseEntity.ok(response);
    }
}
