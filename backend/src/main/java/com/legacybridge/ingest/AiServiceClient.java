package com.legacybridge.ingest;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.UUID;

/** Bounded HTTP adapter; durable delivery/retries are owned by AiSyncWorker. */
@Component
public class AiServiceClient {
    private final RestClient restClient;

    public AiServiceClient(@Value("${legacybridge.ai-service.base-url:http://localhost:8001}") String baseUrl,
                           @Value("${legacybridge.ai-service.connect-timeout-ms:3000}") int connectMs,
                           @Value("${legacybridge.ai-service.read-timeout-ms:90000}") int readMs) {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(connectMs);
        factory.setReadTimeout(readMs);
        restClient = RestClient.builder().baseUrl(baseUrl).requestFactory(factory).build();
    }

    public void index(UUID repositoryId) {
        restClient.post().uri("/index/{id}", repositoryId).retrieve().toBodilessEntity();
    }

    /** Python DELETE /index/{id} removes derived graph entries. PostgreSQL
     * rows are deleted by Java FK cascade, not by a remote service. */
    public void deleteIndex(UUID repositoryId) {
        restClient.delete().uri("/index/{id}", repositoryId).retrieve().toBodilessEntity();
    }
}
