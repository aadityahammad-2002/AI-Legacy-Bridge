package com.legacybridge.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/** Reject oversized declared ingest payloads before Jackson allocates JSON trees.
 * Reverse proxy must also cap chunked/unknown-length requests. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class IngestSizeFilter extends OncePerRequestFilter {
    private final long maxBytes;

    public IngestSizeFilter(@Value("${legacybridge.ingest.max-request-bytes:67108864}") long maxBytes) {
        this.maxBytes = maxBytes;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        if ("POST".equalsIgnoreCase(request.getMethod())
                && request.getRequestURI().equals("/api/repository/ingest")
                && request.getContentLengthLong() > maxBytes) {
            response.sendError(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE, "Analysis payload too large");
            return;
        }
        chain.doFilter(request, response);
    }
}
