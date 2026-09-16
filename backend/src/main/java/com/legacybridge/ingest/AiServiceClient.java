package com.legacybridge.ingest;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * Triggers the Python AI service's POST /index/{repositoryId} after ingest
 * completes — this replaced the old in-process RagIndexingService.indexAsync
 * call (see ai-service/README.md for the full picture of what moved to
 * Python). Fire-and-forget, same as the old @Async call: ingest's response
 * to the frontend doesn't wait on indexing finishing.
 *
 * IMPORTANT: the Python service re-queries methods/classes/dependencies
 * from Postgres itself rather than receiving them in the request body, so
 * this MUST be called only after IngestService's transaction has committed
 * — otherwise the Python side's SELECT would run against a connection that
 * can't see the just-inserted rows yet. See IngestService, which registers
 * this call via TransactionSynchronization#afterCommit rather than calling
 * it directly inline.
 */
@Component
public class AiServiceClient {

    private static final Logger log = LoggerFactory.getLogger(AiServiceClient.class);

    private final RestClient restClient;

    public AiServiceClient(@Value("${legacybridge.ai-service.base-url:http://localhost:8001}") String baseUrl) {
        this.restClient = RestClient.builder().baseUrl(baseUrl).build();
    }

    /**
     * Fire-and-forget trigger. Indexing failure must not affect ingest's
     * success response — AI Explorer will just have no/partial RAG context
     * for this repository until re-indexed. Logged loudly since this is
     * otherwise silent, same behavior RagIndexingService.indexAsync had.
     */
    public void triggerIndexAsync(UUID repositoryId) {
        CompletableFuture.runAsync(() -> {
            try {
                restClient.post()
                        .uri("/index/{repositoryId}", repositoryId)
                        .retrieve()
                        .toBodilessEntity();
                log.info("Triggered AI service indexing for repository {}", repositoryId);
            } catch (Exception e) {
                log.error("Failed to trigger AI service indexing for repository {}: {}",
                        repositoryId, e.getMessage(), e);
            }
        });
    }
}
