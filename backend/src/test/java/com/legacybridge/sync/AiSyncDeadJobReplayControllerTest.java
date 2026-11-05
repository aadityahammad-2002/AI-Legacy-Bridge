package com.legacybridge.sync;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.http.HttpStatus;

import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class AiSyncDeadJobReplayControllerTest {
    private static final String TOKEN = "1ca53463d1ba48439674e44d7e39e949";
    private final AiSyncJobRepository jobs = mock(AiSyncJobRepository.class);
    private final AiSyncDeadJobReplayController controller =
            new AiSyncDeadJobReplayController(jobs, TOKEN);
    private final UUID id = UUID.randomUUID();

    @Test
    void allowsOnlyExplicitReplayForDeadCurrentIndexJob() {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr("127.0.0.1");
        when(jobs.replayDeadIndex(id)).thenReturn(true);
        var response = controller.replayDeadIndex(id, TOKEN, request);
        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        assertEquals("PENDING", response.getBody().get("status"));
        verify(jobs).replayDeadIndex(id);
    }

    @Test
    void rejectsRemoteCallerEvenWithCorrectToken() {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr("192.168.1.50");
        assertEquals(HttpStatus.FORBIDDEN, controller.replayDeadIndex(id, TOKEN, request).getStatusCode());
        verifyNoInteractions(jobs);
    }

    @Test
    void rejectsAbsentOrWrongTokenWithoutTouchingDatabase() {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr("::1");
        assertEquals(HttpStatus.FORBIDDEN, controller.replayDeadIndex(id, null, request).getStatusCode());
        assertEquals(HttpStatus.FORBIDDEN, controller.replayDeadIndex(id, "bad", request).getStatusCode());
        verifyNoInteractions(jobs);
    }

    @Test
    void rejectsStaleDeletedOrNonDeadJob() {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr("127.0.0.1");
        when(jobs.replayDeadIndex(id)).thenReturn(false);
        assertEquals(HttpStatus.CONFLICT,
                controller.replayDeadIndex(id, TOKEN, request).getStatusCode());
    }

    @Test
    void requiresLongOperatorTokenWhenEnabled() {
        assertThrows(IllegalStateException.class,
                () -> new AiSyncDeadJobReplayController(jobs, "short"));
    }
}
