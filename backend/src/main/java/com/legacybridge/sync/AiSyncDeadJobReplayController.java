package com.legacybridge.sync;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.UUID;

/**
 * Local operator-only replay, disabled unless explicitly enabled.
 * It does not provide user authentication and is not a public management API.
 * The secret header and raw socket peer loopback restriction are both required.
 */
@RestController
@RequestMapping("/api/maintenance/ai-sync")
@ConditionalOnProperty(name = "legacybridge.ai-jobs.replay-enabled", havingValue = "true")
public class AiSyncDeadJobReplayController {
    private static final Logger log = LoggerFactory.getLogger(AiSyncDeadJobReplayController.class);
    private final AiSyncJobRepository jobs;
    private final byte[] configuredToken;

    public AiSyncDeadJobReplayController(AiSyncJobRepository jobs,
            @Value("${legacybridge.ai-jobs.replay-token:}") String replayToken) {
        if (replayToken == null || replayToken.length() < 32) {
            throw new IllegalStateException(
                "Manual replay was enabled without a sufficiently long local replay token");
        }
        this.jobs = jobs;
        this.configuredToken = replayToken.getBytes(StandardCharsets.UTF_8);
    }

    /** The token is accepted only for loopback requests, regardless of forwarded headers. */
    @PostMapping("/{repositoryId}/replay-dead-index")
    public ResponseEntity<Map<String, String>> replayDeadIndex(@PathVariable UUID repositoryId,
            @RequestHeader(value = "X-LegacyBridge-Replay-Token", required = false) String presentedToken,
            HttpServletRequest request) {
        if (!isLoopback(request.getRemoteAddr()) || presentedToken == null ||
                !MessageDigest.isEqual(configuredToken,
                    presentedToken.getBytes(StandardCharsets.UTF_8))) {
            return ResponseEntity.status(403).body(Map.of("error", "Forbidden"));
        }
        boolean requeued = jobs.replayDeadIndex(repositoryId);
        if (!requeued) {
            return ResponseEntity.status(409).body(Map.of(
                "error", "No eligible DEAD INDEX job for this repository and current revision"));
        }
        log.info("Operator replayed DEAD INDEX job for repository {}", repositoryId);
        return ResponseEntity.accepted().body(Map.of(
                "repositoryId", repositoryId.toString(), "status", "PENDING"));
    }

    private static boolean isLoopback(String remoteAddress) {
        try {
            return remoteAddress != null && InetAddress.getByName(remoteAddress).isLoopbackAddress();
        } catch (Exception exception) {
            return false;
        }
    }
}
