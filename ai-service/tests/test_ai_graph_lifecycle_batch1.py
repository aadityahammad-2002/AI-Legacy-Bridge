"""Batch 1: protect LangGraph session state from stale repo revisions."""

from app import agent_graph


def test_graph_cache_replaced_on_repository_revision_change(monkeypatch):
    builds = []
    def fake_build(repository_id, cache):
        graph = object()
        builds.append((repository_id, graph))
        return graph

    monkeypatch.setattr(agent_graph, "build_graph", fake_build)
    agent_graph._graph_cache.clear()
    try:
        g1 = agent_graph._get_graph("repo-1", 1)
        assert agent_graph._get_graph("repo-1", 1) is g1
        g2 = agent_graph._get_graph("repo-1", 2)
        assert g2 is not g1
        assert len(builds) == 2
        agent_graph.evict_repository("repo-1")
        assert "repo-1" not in agent_graph._graph_cache
    finally:
        agent_graph._graph_cache.clear()


def test_touched_files_collect_only_latest_tool_batch(monkeypatch):
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
    from app import langchain_tools

    # Source tracking must use actual tool artifacts, without re-executing
    # tool bodies (search_code would make another embedding call).
    monkeypatch.setattr(langchain_tools, "collect_touched_files",
                        lambda *args: (_ for _ in ()).throw(AssertionError("tool was rerun")))
    node = agent_graph._build_touched_files_node("repo-1", {})
    state = {
        "messages": [
            HumanMessage(content="Old request"),
            AIMessage(content="", tool_calls=[{"name": "read_file", "args": {"path": "old.py"}, "id": "t1"}]),
            ToolMessage(content="old source", tool_call_id="t1",
                        artifact={"touched_files": ["old.py"]}),
            HumanMessage(content="New request"),
            AIMessage(content="", tool_calls=[{"name": "search_code", "args": {"query": "latest"}, "id": "t2"}]),
            ToolMessage(content="current source", tool_call_id="t2",
                        artifact={"touched_files": ["current.py"]}),
        ],
        "touched_files": [],
        "tool_rounds": 0,
    }
    result = node(state)
    assert result["touched_files"] == ["current.py"]
    assert result["tool_rounds"] == 1
