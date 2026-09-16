"""
Port of ai/GroqClient.java. Thin client for an OpenAI-compatible chat
completions API (Groq or Gemini's OpenAI-compat endpoint — see config.py).
Supports tool-calling: pass a running message list + tool definitions, get
back either a final text answer or a set of tool calls to execute (see
agent_orchestrator.py, which drives the loop).

Guards against the same two failure modes the Java version did:
1. Connect/DNS stalls — hard request timeout.
2. TPM rate limits — checked proactively via token_budget before a call is
   even made, so we fail fast with an accurate wait time instead of
   discovering it via a 429 after the fact.
"""
import time
import threading
import httpx
from dataclasses import dataclass, field
from . import config, token_budget

_last_call_lock = threading.Lock()
_last_call_timestamp = 0.0


class LlmError(Exception):
    pass


@dataclass
class ToolCall:
    id: str
    name: str
    arguments_json: str


@dataclass
class AssistantTurn:
    content: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)
    raw_assistant_message: dict = field(default_factory=dict)


def _wait_for_pacing():
    global _last_call_timestamp
    with _last_call_lock:
        now = time.time()
        elapsed = now - _last_call_timestamp
        if elapsed < config.MIN_GAP_BETWEEN_CALLS_SECONDS:
            time.sleep(config.MIN_GAP_BETWEEN_CALLS_SECONDS - elapsed)
        _last_call_timestamp = time.time()


def _estimate_tokens(messages: list[dict], tools: list[dict] | None) -> int:
    chars = sum(len(m.get("content") or "") for m in messages if isinstance(m.get("content"), str))
    tool_chars = (len(tools) * 400) if tools else 0
    # rough heuristic: ~4 chars/token, generous buffer for completion + formatting overhead
    return (chars // 4) + (tool_chars // 4) + 1200


def chat_with_tools(messages: list[dict], tools: list[dict] | None = None,
                     tool_choice: str | None = None) -> AssistantTurn:
    if tool_choice is None and tools:
        tool_choice = "auto"

    if not config.LLM_API_KEY:
        raise LlmError(
            "LEGACYBRIDGE_LLM_API_KEY is not set — configure it in the environment "
            "before using AI Explorer."
        )

    estimated_tokens = _estimate_tokens(messages, tools)
    wait_seconds = token_budget.seconds_until_budget_available(estimated_tokens)
    if wait_seconds > 0:
        raise LlmError(
            f"Token budget for this minute is used up — about {int(wait_seconds) + 1} "
            "more seconds until it frees up automatically. Try again shortly."
        )

    request_body: dict = {
        "model": config.LLM_MODEL,
        "messages": messages,
        "temperature": 0.3,
    }
    if tools:
        request_body["tools"] = tools
        if tool_choice:
            request_body["tool_choice"] = tool_choice

    root = _post_with_retry(request_body)

    choices = root.get("choices")
    if not choices:
        raise LlmError("LLM provider returned an empty response")

    actual_tokens = (root.get("usage") or {}).get("total_tokens", estimated_tokens)
    token_budget.record(actual_tokens)

    message = choices[0]["message"]
    content = message.get("content")

    raw_assistant_message: dict = {"role": "assistant", "content": content}

    tool_calls: list[ToolCall] = []
    raw_tool_calls = message.get("tool_calls") or []
    if raw_tool_calls:
        parsed_raw = []
        for tc in raw_tool_calls:
            fn = tc.get("function", {})
            tool_calls.append(ToolCall(
                id=tc.get("id", ""),
                name=fn.get("name", ""),
                arguments_json=fn.get("arguments", "{}"),
            ))
            parsed_raw.append(tc)
        raw_assistant_message["tool_calls"] = parsed_raw

    return AssistantTurn(content=content, tool_calls=tool_calls, raw_assistant_message=raw_assistant_message)


def _post_with_retry(request_body: dict) -> dict:
    attempt = 0
    while True:
        try:
            _wait_for_pacing()
            return _call_with_timeout(request_body)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                retry_after = e.response.headers.get("Retry-After")
                wait_seconds = float(retry_after) if retry_after else (attempt + 1)
                attempt += 1
                if attempt > config.MAX_RETRIES or wait_seconds > config.MAX_RETRY_WAIT_SECONDS:
                    raise LlmError(
                        f"The LLM provider's rate limit is exhausted for now — it's asking to wait "
                        f"{int(wait_seconds)} seconds. Try again shortly, or ask a smaller/simpler question."
                    ) from e
                time.sleep(wait_seconds)
                continue
            raise


def _call_with_timeout(request_body: dict) -> dict:
    try:
        with httpx.Client(timeout=config.CALL_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{config.LLM_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {config.LLM_API_KEY}"},
                json=request_body,
            )
            response.raise_for_status()
            return response.json()
    except httpx.TimeoutException as e:
        raise LlmError(
            f"LLM call timed out after {config.CALL_TIMEOUT_SECONDS}s — "
            f"check network/DNS connectivity to {config.LLM_BASE_URL}"
        ) from e
