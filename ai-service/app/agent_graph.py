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
from typing import Annotated, TypedDict
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
from langchain_core.messages.utils import trim_messages
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.checkpoint.memory import MemorySaver
from langchain_openai import ChatOpenAI
from langchain_google_genai import ChatGoogleGenerativeAI


from . import config, token_budget, guardrails, langchain_tools

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


def _build_agent_node(repository_id: str, cache: dict, tools_list):
    llm_with_tools = _make_llm(repository_id, cache, tools_list)

    def agent_node(state: AgentState) -> dict:
        # Proactive token-budget check (same intent as the old
        # TokenBudgetTracker) before every model call in the loop, not just
        # the first one — a long tool-calling conversation can burn budget
        # mid-loop just as easily as on the first call.
        rough_chars = sum(len(getattr(m, "content", "") or "") for m in state["messages"])
        estimated_tokens = (rough_chars // 4) + 1200
        wait = token_budget.seconds_until_budget_available(estimated_tokens)
        if wait > 0:
            raise RuntimeError(
                f"Token budget for this minute is used up — about {int(wait) + 1} "
                "more seconds until it frees up automatically. Try again shortly."
            )

        system = SystemMessage(content=_system_prompt(state["context_text"]))
        # Trim history defensively so a very long thread can't grow
        # unbounded — token_counter=len here means "count messages", so
        # this keeps roughly the last 12 turns rather than doing precise
        # token counting (good enough for a safety cap; the token_budget
        # check above is what actually protects the real token limit).
        trimmed = trim_messages(
            state["messages"], max_tokens=24, token_counter=len,
            strategy="last", include_system=False, allow_partial=False,
        )
        response = llm_with_tools.invoke([system, *trimmed])

        usage = getattr(response, "response_metadata", {}).get("token_usage", {})
        token_budget.record(usage.get("total_tokens", estimated_tokens))

        return {"messages": [response]}

    return agent_node


def _agent_edge(state: AgentState) -> str:
    last = state["messages"][-1]
    tool_calls = getattr(last, "tool_calls", None)
    return "tools" if tool_calls else "end"


def _build_touched_files_node(repository_id: str, cache: dict):
    def track_touched_files(state: AgentState) -> dict:
        # Runs right after the ToolNode executes — re-derive which files
        # each just-executed tool call touched (cache hit, effectively
        # free) so the API response can populate sourceFiles.
        touched = list(state.get("touched_files", []))
        for m in state["messages"]:
            if isinstance(m, AIMessage) and m.tool_calls:
                for call in m.tool_calls:
                    files = langchain_tools.collect_touched_files(
                        call["name"], _json.dumps(call["args"]), repository_id, cache
                    )
                    for f in files:
                        if f not in touched:
                            touched.append(f)
        return {"touched_files": touched}

    return track_touched_files


def build_graph(repository_id: str, cache: dict):
    tools_list = langchain_tools.build_tools(repository_id, cache)
    agent_node = _build_agent_node(repository_id, cache, tools_list)
    touched_files_node = _build_touched_files_node(repository_id, cache)

    graph = StateGraph(AgentState)
    graph.add_node("guardrail", _guardrail_node)
    graph.add_node("blocked", _blocked_response_node)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", ToolNode(tools_list))
    graph.add_node("track_touched_files", touched_files_node)

    graph.set_entry_point("guardrail")
    graph.add_conditional_edges("guardrail", _guardrail_edge, {"blocked": "blocked", "continue": "agent"})
    graph.add_edge("blocked", END)
    graph.add_conditional_edges("agent", _agent_edge, {"tools": "tools", "end": END})
    graph.add_edge("tools", "track_touched_files")
    graph.add_edge("track_touched_files", "agent")

    return graph.compile(checkpointer=MemorySaver())


# One compiled graph per repository_id (tools/cache are per-repository, not
# per-request, so the graph itself can be reused across requests for the
# same repo — only the checkpointer's thread_id varies per conversation).
_graph_cache: dict[str, object] = {}


def _get_graph(repository_id: str):
    if repository_id not in _graph_cache:
        _graph_cache[repository_id] = build_graph(repository_id, cache={})
    return _graph_cache[repository_id]


def run(repository_id: str, context_text: str, question: str, thread_id: str) -> dict:
    """
    thread_id scopes conversation memory — pass the same thread_id across
    requests to keep multi-turn context; pass a fresh one to start a clean
    conversation. main.py defaults thread_id to repository_id if the caller
    doesn't specify a sessionId, so by default all questions about one repo
    share memory unless the frontend asks for isolation.
    """
    graph = _get_graph(repository_id)
    config_arg = {"configurable": {"thread_id": thread_id}, "recursion_limit": MAX_TOOL_ROUNDS * 3 + 4}

    result = graph.invoke(
        {
            "messages": [HumanMessage(content=question)],
            "repository_id": repository_id,
            "context_text": context_text,
            "touched_files": [],
            "blocked": False,
            "block_reason": None,
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