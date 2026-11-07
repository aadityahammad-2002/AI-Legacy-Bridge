"""Process-local rolling token budget with atomic reservations.

Batch 3 fixes a concurrency race: checking remaining tokens and recording
usage after a provider call permitted simultaneous requests to exceed TPM.
Reservations hold estimated capacity until the response settles; a failed
call releases it. Multi-worker deployments still require a shared limiter.
"""
import threading
import time
from collections import deque
from . import config

WINDOW_SECONDS = 60.0
_lock = threading.Lock()
# entries: (timestamp, token_count, optional reservation token)
_usage_log: deque[tuple[float, int, object | None]] = deque()


def _prune(now: float):
    while _usage_log and now - _usage_log[0][0] >= WINDOW_SECONDS:
        _usage_log.popleft()


def _wait_for_capacity(now: float, required: int) -> float:
    max_tokens = config.TPM_LIMIT - config.TPM_SAFETY_BUFFER
    if required > max_tokens:
        # A request that exceeds the entire window will never fit.
        return float("inf")
    accumulated = sum(entry[1] for entry in _usage_log)
    if accumulated + required <= max_tokens:
        return 0.0
    for timestamp, tokens, _ in _usage_log:
        accumulated -= tokens
        if accumulated + required <= max_tokens:
            return max(timestamp + WINDOW_SECONDS - now, 0.001)
    return WINDOW_SECONDS


def seconds_until_budget_available(estimated_tokens: int) -> float:
    with _lock:
        now = time.monotonic()
        _prune(now)
        return _wait_for_capacity(now, max(0, int(estimated_tokens)))


def reserve(estimated_tokens: int):
    """Return (ticket, wait_seconds). A None ticket means denied."""
    estimated = max(0, int(estimated_tokens))
    with _lock:
        now = time.monotonic()
        _prune(now)
        wait = _wait_for_capacity(now, estimated)
        if wait > 0:
            return None, wait
        ticket = object()
        _usage_log.append((now, estimated, ticket))
        return ticket, 0.0


def finish(ticket, actual_tokens: int):
    """Reconcile an estimate to observed provider usage, if available."""
    if ticket is None:
        return
    with _lock:
        now = time.monotonic()
        _prune(now)
        for index, (when, estimated, old_ticket) in enumerate(_usage_log):
            if old_ticket is ticket:
                _usage_log[index] = (when, max(0, int(actual_tokens)), None)
                break


def cancel(ticket):
    if ticket is None:
        return
    with _lock:
        for entry in list(_usage_log):
            if entry[2] is ticket:
                _usage_log.remove(entry)
                break


def record(tokens: int):
    """Compatibility helper for known costs not using reservations."""
    with _lock:
        now = time.monotonic()
        _prune(now)
        _usage_log.append((now, max(0, int(tokens)), None))
