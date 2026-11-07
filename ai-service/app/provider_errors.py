"""Safe provider error classification, shared by native Gemini and OpenAI adapters.

Only fixed, actionable error messages are returned to the caller. Provider
exception bodies may contain API keys, request payloads or source code and
must never be echoed into an HTTP response.
"""


class ProviderFailure(RuntimeError):
    def __init__(self, message: str, http_status: int = 503):
        super().__init__(message)
        self.http_status = http_status


def _http_code(exc):
    for field in ("status_code", "code"):
        value = getattr(exc, field, None)
        if callable(value):
            try:
                value = value()
            except Exception:
                continue
        if isinstance(value, int) and 400 <= value <= 599:
            return value
        # grpc status enum: RESOURCE_EXHAUSTED -> 429, INVALID_ARGUMENT -> 400
        text = str(getattr(value, "name", value) or "").upper()
        if text in ("RESOURCE_EXHAUSTED", "TOO_MANY_REQUESTS"):
            return 429
        if text in ("PERMISSION_DENIED", "UNAUTHENTICATED"):
            return 403
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if isinstance(status, int) and 400 <= status <= 599:
        return status
    return None


def classify(exc: Exception) -> ProviderFailure | None:
    """Walk exception causes without exposing arbitrary exception text."""
    current = exc
    seen = set()
    for _ in range(6):
        if id(current) in seen:
            break
        seen.add(id(current))
        if isinstance(current, ProviderFailure):
            return current
        status = _http_code(current)
        error_type = type(current).__name__.lower()
        if status == 402:
            return ProviderFailure("LLM provider requires API credits or payment (HTTP 402)", 402)
        if status in (401, 403):
            return ProviderFailure("LLM provider API key or model access was rejected", 503)
        if status == 429 or "resourceexhausted" in error_type or "ratelimit" in error_type:
            return ProviderFailure("LLM quota or rate limit reached; retry after the provider quota resets", 429)
        if status in (408, 504) or "timeout" in error_type or "deadlineexceeded" in error_type:
            return ProviderFailure("LLM provider request timed out; retry later", 503)
        if status is not None and status >= 500:
            return ProviderFailure("LLM provider temporarily unavailable", 503)
        if status == 400 or "invalidargument" in error_type:
            return ProviderFailure("LLM provider rejected the model request; check model/tool compatibility", 502)
        # Do not translate an unrelated local Python exception into a provider
        # failure or mask the underlying bug as quota exhaustion.
        next_exception = getattr(current, "__cause__", None) or getattr(current, "__context__", None)
        if next_exception is None:
            break
        current = next_exception
    return None
