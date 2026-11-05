package com.legacybridge.sync;

import com.legacybridge.ingest.AiServiceClient;
import com.legacybridge.storage.repository.RepositoryEntityRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Bounded poll/lease/retry worker. A crash leaves a lease that can be reclaimed. */
@Component
public class AiSyncWorker {
    private static final Logger log = LoggerFactory.getLogger(AiSyncWorker.class);
    private final AiSyncJobRepository jobs;
    private final AiServiceClient client;
    private final RepositoryEntityRepository repositories;
    private final int leaseSeconds, maxAttempts;

    public AiSyncWorker(AiSyncJobRepository jobs, AiServiceClient client,
                        RepositoryEntityRepository repositories,
                        @Value("${legacybridge.ai-jobs.lease-seconds:180}") int leaseSeconds,
                        @Value("${legacybridge.ai-jobs.max-attempts:8}") int maxAttempts) {
        this.jobs = jobs;
        this.client = client;
        this.repositories = repositories;
        this.leaseSeconds = leaseSeconds;
        this.maxAttempts = maxAttempts;
    }

    @Scheduled(fixedDelayString = "${legacybridge.ai-jobs.poll-ms:3000}",
               initialDelayString = "${legacybridge.ai-jobs.initial-delay-ms:5000}")
    public void poll() {
        // If DB is down, let scheduler log error and retry on next poll.
        // Claim one at a time: claiming a batch before sequential 90s HTTP calls
        // could exhaust a later job's lease and create duplicate processing.
        for (var job : jobs.claim(1, leaseSeconds)) {
            process(job);
        }
    }

    void process(AiSyncJobRepository.Job job) {
        try {
            if (job.operation().equals("INDEX")) {
                // A deleted or superseded repository must never be re-indexed.
                var currentRevision = repositories.findRevisionById(job.repositoryId());
                if (currentRevision.isEmpty() || currentRevision.get() != job.revision()) {
                    jobs.complete(job);
                    return;
                }
                client.index(job.repositoryId());
            } else if (job.operation().equals("DELETE")) {
                // A repo re-created with the same id must not have its graph removed.
                if (repositories.existsById(job.repositoryId())) {
                    jobs.complete(job);
                    return;
                }
                client.deleteIndex(job.repositoryId());
            } else {
                throw new IllegalStateException("Unsupported AI sync operation");
            }
            jobs.complete(job);
        } catch (Exception ex) {
            long seconds = Math.min(3600L, 1L << Math.min(12, Math.max(1, job.attempts())));
            // Do not store raw HTTP response bodies or secrets in the DB.
            jobs.fail(job, maxAttempts, seconds, ex.getClass().getSimpleName());
            log.warn("AI sync {} for repository {} failed (attempt {}): {}",
                    job.operation(), job.repositoryId(), job.attempts(), ex.getClass().getSimpleName());
        }
    }
}
