package com.legacybridge.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.legacybridge.ingest.dto.IngestResponse;
import jakarta.validation.Validation;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class IngestControllerSnapshotTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void retainsAllUnknownAnalysisSectionsAndUnmodifiedSourceContent() throws Exception {
        UUID id = UUID.randomUUID();
        String json = """
                {
                  "repositoryId":"%s", "repository":{"name":"demo","source":"zip"},
                  "files":[{"path":"src/a.py","language":"Python","loc":2,"complexity":72,"content":"print(\\\"hi\\\")\\n"}],
                  "functions":[], "classes":[], "imports":[], "dependencies":[],
                  "graph":{"nodes":[],"edges":[]},
                  "healthScore":{"score":78,"grade":"B"},
                  "architectureIntelligence":{"nested":{"evidence":[1,2,3]}},
                  "advancedAnalysis":{"allFutureFields":{"unknown":"retained"}}
                }
                """.formatted(id);
        JsonNode payload = MAPPER.readTree(json);
        IngestService service = mock(IngestService.class);
        when(service.ingest(any(), any())).thenReturn(new IngestResponse(id, 1, 0, 0, 0));
        try (var factory = Validation.buildDefaultValidatorFactory()) {
            var controller = new IngestController(service, MAPPER, factory.getValidator());
            ResponseEntity<IngestResponse> response = controller.ingest(payload);
            assertEquals(200, response.getStatusCode().value());
            var snapshot = org.mockito.ArgumentCaptor.forClass(JsonNode.class);
            verify(service).ingest(any(), snapshot.capture());
            assertEquals(payload, snapshot.getValue());
            assertEquals("print(\"hi\")\n", snapshot.getValue().get("files").get(0).get("content").asText());
            assertEquals("retained", snapshot.getValue().at("/advancedAnalysis/allFutureFields/unknown").asText());
            assertEquals(72, snapshot.getValue().at("/files/0/complexity").asInt());
        }
    }

    @Test
    void nestedFileValidationRejectsEmptyPathBeforeDatabaseWrite() throws Exception {
        UUID id = UUID.randomUUID();
        JsonNode payload = MAPPER.readTree("""
                {"repositoryId":"%s", "repository":{"name":"demo","source":"zip"},
                 "files":[{"path":""}], "functions":[], "classes":[],
                 "imports":[], "dependencies":[], "graph":{},
                 "healthScore":{"score":0,"grade":"F"}}
                """.formatted(id));
        IngestService service = mock(IngestService.class);
        try (var factory = Validation.buildDefaultValidatorFactory()) {
            var controller = new IngestController(service, MAPPER, factory.getValidator());
            assertThrows(jakarta.validation.ConstraintViolationException.class, () -> controller.ingest(payload));
            verifyNoInteractions(service);
        }
    }
}
