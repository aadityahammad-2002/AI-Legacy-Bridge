"""
Port of ai/TokenBudgetTracker.java. Tracks LLM token usage in a rolling
60-second window so we can tell, BEFORE making a call, whether there's
budget left — instead of firing the request and reacting to a 429.

Process-local, same as the Java version (an in-memory deque on a single
Spring bean) — if you run multiple instances of this service behind a load
balancer, each instance tracks its own budget independently, same caveat
the Java version had as a single-instance app.
"""
import time
import threading
from collections import deque
from . import config

WINDOW_SECONDS = 60.0

_lock = threading.Lock()
_usage_log: deque[tuple[float, int]] = deque()  # (timestamp, tokens)


def _prune(now: float):
    while _usage_log and now - _usage_log[0][0] > WINDOW_SECONDS:
        _usage_log.popleft()


def record(tokens: int):
    with _lock:
        now = time.time()
        _prune(now)
        _usage_log.append((now, tokens))


def seconds_until_budget_available(estimated_tokens: int) -> float:
    """Returns 0 if there's enough budget right now, else seconds to wait."""
    with _lock:
        now = time.time()
        _prune(now)
        used = sum(t for _, t in _usage_log)
        if used + estimated_tokens + config.TPM_SAFETY_BUFFER <= config.TPM_LIMIT:
            return 0.0
        if not _usage_log:
            return 0.0
        oldest_ts = _usage_log[0][0]
        return max((oldest_ts + WINDOW_SECONDS) - now, 1.0)
