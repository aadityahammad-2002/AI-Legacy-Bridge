"""
LangGraph agent. Replaces agent_orchestrator.py's hand-written for-loop
with a proper StateGraph:

    guardrail --(unsafe)--> END (refusal)
       |
     (safe)
       v
    retrieve_context
       v
    agent <----> tools   (loop while the model keeps calling tools)
       |
     (no more tool calls)
       v
      END

Two things this version has that the old manual loop did NOT:

1. Multi-turn memory. A MemorySaver checkpointer persists conversation
   state keyed by `thread_id`. Callers pass a thread_id (see main.py's
   AskRequest.sessionId) and every question in that thread sees the full
   prior conversation — the old version treated every question as
   independent unless the frontend manually replayed history.

2. Tool-call loop control via LangGraph's own recursion_limit instead of a
   hand-rolled iteration counter + a special "final call with no tools"
   fallback — LangGraph's prebuilt ToolNode + conditional edges handle the
   loop-until-no-tool-calls pattern natively.
"""
import json as _json
import logging
import threading
import weakref
from typing import Annotated, TypedDict
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage, RemoveMessage
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.checkpoint.memory import MemorySaver
from langchain_openai import ChatOpenAI
from langchain_google_genai import ChatGoogleGenerativeAI


from . import config, token_budget, guardrails, langchain_tools, provider_errors, llm_client

log = logging.getLogger("legacybridge.agent_graph")

MAX_TOOL_ROUNDS = 4  # mirrors the old MAX_ITERATIONS cap, enforced via recursion_limit in run()

ROLE = (
    "You are the AI Explorer inside AI Legacy Bridge, a tool that helps "
    "developers understand an unfamiliar codebase. You're talking with a developer who is looking at "
    "this specific repository right now — help them with whatever they ask: understanding code, "
    "finding bugs, assessing security, planning a migration, or just getting oriented quickly. "
    "This is an ongoing conversation — later questions may refer back to things discussed earlier; "
    "use that history naturally, the way a colleague who remembers the conversation would."
)

STYLE_GUIDE = (
    "\n\nHow to respond: write like you're chatting with the "
    "developer directly, not authoring documentation. Keep it conversational and to the point — a "
    "few short paragraphs is usually enough; only go longer if the question genuinely needs it. Avoid "
    "heavy markdown structure (no ## headers, no tables, no \"TL;DR\" summary sections, no restating "
    "the question as a title) unless the user specifically asks for a structured breakdown. Reference "
    "real file/function names inline as part of normal sentences rather than building a reference "
    "table for them. Skip generic wrap-up paragraphs (\"In summary...\", \"Overall, this...\") — just "
    "answer and stop."
)

TOOL_GUIDE = (
    "\n\nYou have tools to explore the repository beyond what's "
    "given below: read_file to see a file's full source, search_code to semantically search across "
    "the codebase (this now also weighs structural closeness in the dependency graph, not just text "
    "similarity), list_files to see what's in a directory, and get_dependencies to see what a file "
    "imports or is used by. Use them when the context below doesn't already answer the question — "
    "don't call a tool for something you can already see. Prefer search_code when you don't know the "
    "exact file, and read_file once you know the path. Don't call more tools than you need."
)

GROUNDING = (
    "\n\nAnswer using the repository context below and the tools "
    "available to you. If something genuinely isn't in the context and isn't findable via the tools "
    "(e.g. a class name that doesn't exist anywhere in the file list), say so plainly rather than "
    "guessing — but never claim you lack a file's source without first checking read_file or "
    "search_code for it."
)


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]
    repository_id: str
    context_text: str
    touched_files: list[str]
    blocked: bool
    block_reason: str | None
    tool_rounds: int


def _system_prompt(context_text: str) -> str:
    return ROLE + STYLE_GUIDE + TOOL_GUIDE + GROUNDING + "\n\n" + context_text


def _make_llm(repository_id: str, cache: dict, tools_list):
    if not config.LLM_API_KEY:
        raise RuntimeError(
            "LEGACYBRIDGE_LLM_API_KEY is not set — configure it in the environment "
            "before using AI Explorer."
        )
    # Gemini via its OpenAI-compat endpoint drops the `thought_signature`
    # that Gemini 2.x/3.x models attach to function-call turns, which
    # breaks the agent<->tools loop on the second round-trip (a 400
    # "missing thought_signature" error). Google's native LangChain
    # integration talks Gemini's real API and round-trips it correctly,
    # so route Gemini models through that client instead. Groq (and any
    # other genuinely OpenAI-compatible provider) keeps using ChatOpenAI.
    if "generativelanguage.googleapis.com" in config.LLM_BASE_URL:
        llm = ChatGoogleGenerativeAI(
            model=config.LLM_MODEL,
            google_api_key=config.LLM_API_KEY,
            temperature=0.3,
            timeout=config.CALL_TIMEOUT_SECONDS,
            max_retries=config.MAX_RETRIES,
        )
    else:
        llm = ChatOpenAI(
            base_url=config.LLM_BASE_URL,
            api_key=config.LLM_API_KEY,
            model=config.LLM_MODEL,
            temperature=0.3,
            timeout=config.CALL_TIMEOUT_SECONDS,
            max_retries=config.MAX_RETRIES,
        )
    return llm.bind_tools(tools_list) if tools_list else llm


def _guardrail_node(state: AgentState) -> dict:
    last_human = next((m for m in reversed(state["messages"]) if isinstance(m, HumanMessage)), None)
    question = last_human.content if last_human else ""
    verdict = guardrails.check_question_safety(question)
    if verdict.safe:
        return {"blocked": False, "block_reason": None}
    return {"blocked": True, "block_reason": verdict.reason}


def _guardrail_edge(state: AgentState) -> str:
    return "blocked" if state.get("blocked") else "continue"


def _blocked_response_node(state: AgentState) -> dict:
    reason = state.get("block_reason") or "This question can't be answered by AI Explorer."
    return {"messages": [AIMessage(content=f"I can't help with that one — {reason}")]}


def _trim_complete_turns(messages: list, max_turns: int = 6,
                         max_history_chars: int = 50000) -> list:
    """Keep recent whole human/assistant/tool conversation turns.

    A turn starts at a HumanMessage. Never begin history with an orphan
    ToolMessage; preserve AI tool-call+ToolMessage adjacency.
    """
    groups = []
    current = []
    for message in messages:
        if isinstance(message, HumanMessage):
            if current:
                groups.append(current)
            current = [message]
        elif current:
            current.append(message)
    if current:
        groups.append(current)
    selected = []
    size = 0
    for group in reversed(groups[-max_turns:]):
        group_size = sum(len(str(getattr(m, "content", ""))) for m in group)
        if selected and size + group_size > max_history_chars:
            break
        selected.insert(0, group)
        size += group_size
    return [message for group in selected for message in group]


def _estimate_prompt_tokens(messages: list) -> int:
    """Approximate cost including Gemini content blocks and tool JSON."""
    import json
    chars = 0
    for message in messages:
        content = getattr(message, "content", "")
        chars += len(content) if isinstance(content, str) else len(json.dumps(content, default=str))
        chars += len(json.dumps(getattr(message, "tool_calls", []) or [], default=str))
    return chars // 4 + 1200


def _messages_to_prune(messages: list, kept: list) -> list:
    """Remove older complete turns from the checkpoint, not just the prompt.

    `add_messages` assigns each message an id, so RemoveMessage can delete
    the same ids from the in-memory checkpoint without orphaning tools.
    """
    kept_ids = {m.id for m in kept if getattr(m, "id", None)}
    return [RemoveMessage(id=m.id) for m in messages
            if getattr(m, "id", None) and m.id not in kept_ids]


def _provider_invoke(llm, messages: list):
    estimated = _estimate_prompt_tokens(messages)
    ticket, wait = token_budget.reserve(estimated)
    if ticket is None:
        suffix = "Request exceeds the configured per-minute token limit" if wait == float("inf") else (
            f"Token budget temporarily exhausted; retry in roughly {int(wait) + 1} seconds")
        raise provider_errors.ProviderFailure(suffix, 429)
    try:
        # Share request pacing with the guardrail/code-assist HTTP adapter.
        # LangChain's native model clients otherwise bypassed the configured
        # provider call gap entirely, exhausting low-RPM free quotas.
        llm_client._wait_for_pacing()
        response = llm.invoke(messages)
    except Exception as exc:
        token_budget.cancel(ticket)
        classified = provider_errors.classify(exc)
        if classified is not None:
            raise classified from exc
        raise
    metadata = getattr(response, "response_metadata", {}) or {}
    usage = getattr(response, "usage_metadata", None) or metadata.get("token_usage", {})
    actual = usage.get("total_tokens") if isinstance(usage, dict) else None
    if actual is None and isinstance(usage, dict):
        inputs = usage.get("input_tokens")
        outputs = usage.get("output_tokens")
        if inputs is not None or outputs is not None:
            actual = (inputs or 0) + (outputs or 0)
    token_budget.finish(ticket, actual if actual is not None else estimated)
    return response


def _build_agent_node(repository_id: str, cache: dict, tools_list):
    llm_with_tools = _make_llm(repository_id, cache, tools_list)

    def agent_node(state: AgentState) -> dict:
        # Proactive token-budget check (same intent as the old
        # TokenBudgetTracker) before every model call in the loop, not just
        # the first one — a long tool-calling conversation can burn budget
        # mid-loop just as easily as on the first call.
        system = SystemMessage(content=_system_prompt(state["context_text"]))
        # Keep complete conversation turns (Human -> AI -> Tool -> AI). A
        # naive last-N-messages trim may orphan ToolMessages or AI tool calls,
        # which some providers reject with an invalid tool-call sequence.
        trimmed = _trim_complete_turns(state["messages"], max_turns=6)
        response = _provider_invoke(llm_with_tools, [system, *trimmed])
        # Checkpoint retention must be bounded too, not merely the outgoing
        # prompt; remove only older *complete turns* after a successful call.
        return {"messages": [*_messages_to_prune(state["messages"], trimmed), response]}

    return agent_node


def _agent_edge(state: AgentState) -> str:
    last = state["messages"][-1]
    tool_calls = getattr(last, "tool_calls", None)
    if not tool_calls:
        return "end"
    if state.get("tool_rounds", 0) >= MAX_TOOL_ROUNDS:
        return "limit"
    return "tools"


def _build_touched_files_node(repository_id: str, cache: dict):
    def track_touched_files(state: AgentState) -> dict:
        """Use the actual ToolMessages, never replay repository tools.

        Artifacts are attached by @tool(response_format='content_and_artifact').
        A failed read carries no files. Only replies matching the latest
        assistant tool-call ids are considered, not historical calls.
        """
        touched = list(state.get("touched_files", []))
        messages = state["messages"]
        batch_start = next((i for i in range(len(messages) - 1, -1, -1)
                            if isinstance(messages[i], AIMessage)
                            and getattr(messages[i], "tool_calls", None)), None)
        if batch_start is not None:
            ids = {call["id"] for call in messages[batch_start].tool_calls}
            for reply in messages[batch_start + 1:]:
                if not isinstance(reply, ToolMessage) or reply.tool_call_id not in ids:
                    continue
                artifact = getattr(reply, "artifact", None)
                if not isinstance(artifact, dict):
                    continue
                for path in artifact.get("touched_files", []):
                    if isinstance(path, str) and path and path not in touched:
                        touched.append(path)
        return {"touched_files": touched, "tool_rounds": state.get("tool_rounds", 0) + 1}

    return track_touched_files


def _tool_limit_node(state: AgentState) -> dict:
    """Close pending tool-call ids before returning a bounded terminal answer.

    Executing an unbounded fifth tool batch or ending with unmatched tool
    calls both create provider-specific failures on the next turn.
    """
    last = state["messages"][-1]
    closed = [ToolMessage(content="Tool round limit reached; not executed",
                          tool_call_id=call["id"])
              for call in getattr(last, "tool_calls", [])]
    closed.append(AIMessage(content=(
        "I reached the safe tool-call limit for this question. "
        "Please narrow the request to a file or function so I can continue accurately."
    )))
    return {"messages": closed}


def build_graph(repository_id: str, cache: dict):
    tools_list = langchain_tools.build_tools(repository_id, cache)
    agent_node = _build_agent_node(repository_id, cache, tools_list)
    touched_files_node = _build_touched_files_node(repository_id, cache)

    graph = StateGraph(AgentState)
    graph.add_node("guardrail", _guardrail_node)
    graph.add_node("blocked", _blocked_response_node)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", ToolNode(tools_list))
    graph.add_node("tool_limit", _tool_limit_node)
    graph.add_node("track_touched_files", touched_files_node)

    graph.set_entry_point("guardrail")
    graph.add_conditional_edges("guardrail", _guardrail_edge, {"blocked": "blocked", "continue": "agent"})
    graph.add_edge("blocked", END)
    graph.add_conditional_edges("agent", _agent_edge, {"tools": "tools", "limit": "tool_limit", "end": END})
    graph.add_edge("tool_limit", END)
    graph.add_edge("tools", "track_touched_files")
    graph.add_edge("track_touched_files", "agent")

    return graph.compile(checkpointer=MemorySaver())


# One compiled graph per repository_id (tools/cache are per-repository, not
# per-request, so the graph itself can be reused across requests for the
# same repo — only the checkpointer's thread_id varies per conversation).
_graph_cache: dict[str, tuple[int, object]] = {}
_cache_lock = threading.RLock()
# Weak keys prevent abandoned browser session ids from retaining locks
# permanently. The active invoke holds a strong reference to its lock.
_session_locks = weakref.WeakValueDictionary()


def evict_repository(repository_id: str) -> None:
    """Discard ephemeral session memory after a repository is deleted."""
    with _cache_lock:
        _graph_cache.pop(repository_id, None)


def _get_graph(repository_id: str, revision: int):
    # Lock cache construction; concurrent sessions may ask after re-ingestion.
    with _cache_lock:
        cached = _graph_cache.get(repository_id)
        if cached is None or cached[0] != revision:
            graph = build_graph(repository_id, cache={})
            _graph_cache[repository_id] = (revision, graph)
            return graph
        return cached[1]


def run(repository_id: str, context_text: str, question: str, thread_id: str,
        revision: int = 0) -> dict:
    """
    thread_id scopes conversation memory — pass the same thread_id across
    requests to keep multi-turn context; pass a fresh one to start a clean
    conversation. main.py defaults thread_id to repository_id if the caller
    doesn't specify a sessionId, so by default all questions about one repo
    share memory unless the frontend asks for isolation.
    """
    # MemorySaver checkpointer is safe across *different* thread ids, but
    # concurrent invokes on the same session can race on checkpoint state.
    key = (repository_id, thread_id)
    with _cache_lock:
        session_lock = _session_locks.get(key)
        if session_lock is None:
            session_lock = threading.RLock()
            _session_locks[key] = session_lock
    with session_lock:
        graph = _get_graph(repository_id, revision)
        config_arg = {"configurable": {"thread_id": thread_id},
                      "recursion_limit": MAX_TOOL_ROUNDS * 3 + 8}
        result = graph.invoke(
            {
                "messages": [HumanMessage(content=question)],
                "repository_id": repository_id,
                "context_text": context_text,
                "touched_files": [],
                "blocked": False,
                "block_reason": None,
                "tool_rounds": 0,
            },
            config=config_arg,
        )

    final_message = result["messages"][-1]
    return {
        "answer": _extract_text(getattr(final_message, "content", "")),
        "touched_files": result.get("touched_files", []),
    }


def _extract_text(content) -> str:
    """Gemini's native client sometimes returns content as a list of
    content blocks (e.g. [{'type': 'text', 'text': '...'}]) instead of a
    plain string — normalize either shape to plain text for the API response."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "".join(parts)
    return str(content) if content else ""