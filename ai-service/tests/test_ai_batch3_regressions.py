"""Batch 3 offline regression coverage; no external network/provider calls."""
import threading
import time
from contextlib import contextmanager
from types import SimpleNamespace
import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from app import (agent_graph, config, dependency_graph, graph_rag,
                 provider_errors, token_budget, tools, langchain_tools, main)


def test_dependency_walk_cycle_and_depth():
    graph = dependency_graph.adjacency_for_edges([
        {'source':'a.py','target':'b.py'}, {'source':'b.py','target':'c.py'},
        {'source':'c.py','target':'a.py'}, {'source':'c.py','target':'d.py'},
        {'source':'x.py','target':'x.py'},
    ])
    assert dependency_graph.walk(graph, 'a.py', 1) == {'a.py':0, 'b.py':1, 'c.py':1}
    assert dependency_graph.walk(graph, 'a.py', 2)['d.py'] == 2


def test_pg_graph_scoped_and_bounded_query(monkeypatch):
    recorded = []
    class Cursor:
        def execute(self, sql, params):
            recorded.append((sql, params))
        def fetchall(self):
            return [{'source':'a.py','target':'b.py'}, {'source':'b.py','target':'c.py'}]
    @contextmanager
    def cursor():
        yield Cursor()
    monkeypatch.setattr(dependency_graph.db, 'get_cursor', cursor)
    assert dependency_graph.distance_map('repo-a', 'a.py', ['c.py','missing.py']) == {'c.py':2}
    assert dependency_graph.neighborhood('repo-a', 'a.py') == ['b.py', 'c.py']
    assert 'JOIN files src' in recorded[0][0]
    assert 'JOIN files dst' in recorded[0][0]
    assert recorded[0][1][0] == 'repo-a'
    assert recorded[0][1][1] == dependency_graph.MAX_GRAPH_EDGES + 1


def test_graph_rag_pg_fallback_no_neo4j(monkeypatch):
    monkeypatch.setattr(graph_rag.config, 'NEO4J_PASSWORD', '')
    candidates = [
        {'file_path':'unrelated.py', 'content':'u', 'similarity':.80},
        {'file_path':'near.py', 'content':'n', 'similarity':.74},
    ]
    calls=[]
    monkeypatch.setattr(graph_rag.rag, 'find_similar', lambda repo, vec, count: candidates)
    monkeypatch.setattr(graph_rag.dependency_graph, 'distance_map',
                        lambda repo,anchor,paths: calls.append((repo,anchor,paths)) or {'near.py':1})
    ranked = graph_rag.retrieve_ranked_chunks('r', [.1], 'anchor.py', top_k=2)
    assert [item.file_path for item in ranked] == ['near.py', 'unrelated.py']
    assert ranked[0].graph_distance == 1
    assert len(calls) == 1  # not N+1 SQL queries


def test_neo4j_outage_falls_back_to_pg(monkeypatch):
    monkeypatch.setattr(graph_rag.config, 'NEO4J_PASSWORD', 'configured')
    monkeypatch.setattr(graph_rag.graph_store, 'batch_shortest_path_distances',
                        lambda *a: (_ for _ in ()).throw(ConnectionError('offline')))
    monkeypatch.setattr(graph_rag.dependency_graph, 'distance_map',
                        lambda *a: {'a.py':1})
    assert graph_rag._distances('r', 'anchor', [{'file_path':'a.py'}]) == {'a.py':1}


def test_graph_neighborhood_pg_fallback(monkeypatch):
    monkeypatch.setattr(graph_rag.config, 'NEO4J_PASSWORD', '')
    monkeypatch.setattr(graph_rag.dependency_graph, 'neighborhood', lambda r,a: ['neighbor.py'])
    assert graph_rag.get_structural_neighborhood('r', 'anchor.py') == ['neighbor.py']


def test_batched_neo4j_distances_query(monkeypatch):
    from app import graph_store
    calls = []
    class Session:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def run(self, query, **args):
            calls.append((query,args))
            return [{'path':'a.py','distance':1}, {'path':'b.py','distance':2}]
    monkeypatch.setattr(graph_store,'get_driver',lambda: SimpleNamespace(session=lambda: Session()))
    assert graph_store.batch_shortest_path_distances('r','anchor',['a.py','b.py']) == {'a.py':1,'b.py':2}
    assert len(calls) == 1
    assert calls[0][1]['repo_id'] == 'r'
    assert calls[0][1]['targets'] == ['a.py', 'b.py']


def test_source_artifact_no_tool_reexecution(monkeypatch):
    monkeypatch.setattr(langchain_tools, 'collect_touched_files', lambda *a: pytest.fail('tool rerun'))
    m1 = AIMessage(content='', tool_calls=[{'id':'one','name':'read_file','args':{'path':'a.py'}}])
    m2 = ToolMessage(content='def a(): pass', tool_call_id='one',
                     artifact={'touched_files':['a.py']})
    result=agent_graph._build_touched_files_node('r', {})({
        'messages':[HumanMessage(content='q'), m1, m2], 'touched_files':[], 'tool_rounds':0})
    assert result == {'touched_files':['a.py'],'tool_rounds':1}


def test_failed_tool_has_no_source_artifact():
    m1 = AIMessage(content='', tool_calls=[{'id':'one','name':'read_file','args':{'path':'missing.py'}}])
    result=agent_graph._build_touched_files_node('r', {})({
        'messages':[m1,ToolMessage(content='No file found',tool_call_id='one',
                                   artifact={'touched_files':[]})],
        'touched_files':[], 'tool_rounds':0})
    assert result['touched_files'] == []


def test_tool_limit_closes_pending_calls():
    ai = AIMessage(content='', tool_calls=[{'id':'x1','name':'read_file','args':{'path':'a.py'}},
                                          {'id':'x2','name':'search_code','args':{'query':'foo'}}])
    state={'messages':[ai], 'tool_rounds':agent_graph.MAX_TOOL_ROUNDS}
    assert agent_graph._agent_edge(state) == 'limit'
    stopped = agent_graph._tool_limit_node(state)['messages']
    assert [m.tool_call_id for m in stopped[:-1]] == ['x1','x2']
    assert isinstance(stopped[-1], AIMessage)


def test_history_prunes_old_whole_turns():
    old = [HumanMessage(content='old'), AIMessage(content='old-answer')]
    new = [HumanMessage(content='new'), AIMessage(content='new-answer')]
    for index, message in enumerate(old+new):
        message.id = f'msg{index}'
    removals = agent_graph._messages_to_prune(old+new, new)
    assert {m.id for m in removals} == {'msg0','msg1'}


def test_token_budget_reserves_atomically(monkeypatch):
    token_budget._usage_log.clear()
    monkeypatch.setattr(config, 'TPM_LIMIT', 6000)
    monkeypatch.setattr(config, 'TPM_SAFETY_BUFFER', 0)
    try:
        barrier = threading.Barrier(4)
        results=[]
        def reserve():
            barrier.wait(timeout=2)
            ticket,_ = token_budget.reserve(2500)
            results.append(ticket)
        threads = [threading.Thread(target=reserve) for _ in range(4)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=3)
        assert sum(ticket is not None for ticket in results) == 2
    finally:
        token_budget._usage_log.clear()


def test_provider_error_status_sanitized():
    class Error(Exception):
        status_code = 402
    issue = provider_errors.classify(Error('api_key=top-secret'))
    assert issue.http_status == 402
    assert 'top-secret' not in str(issue)
    class RateError(Exception):
        status_code = 429
    assert provider_errors.classify(RateError()).http_status == 429
    assert provider_errors.classify(ValueError('unrelated local bug')) is None


def test_ask_provider_error_maps_to_http_429(monkeypatch):
    from uuid import UUID
    @contextmanager
    def cursor():
        class C:
            def execute(self,*a): pass
            def fetchone(self): return {'revision':1}
        yield C()
    monkeypatch.setattr(main.db,'get_cursor',cursor)
    monkeypatch.setattr(main.embedding,'embed',lambda *_:[0.0]*384)
    monkeypatch.setattr(main.context_retrieval,'retrieve',lambda *a: SimpleNamespace(to_prompt_text=lambda:'prompt'))
    monkeypatch.setattr(main.agent_graph,'run',lambda *a,**k: (_ for _ in ()).throw(
        provider_errors.ProviderFailure('Quota exhausted',429)))
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as info:
        main.ask(main.AskRequest(repositoryId=UUID('18544b30-b7a7-4122-892d-e68d2349075a'), question='q'))
    assert info.value.status_code == 429


def test_read_file_window_and_exact_path(monkeypatch):
    class Cursor:
        def execute(self, sql, params):
            assert 'repository_id = %s AND path = %s' in sql
            assert params == ('repo', 'src/long.py')
        def fetchone(self):
            return {'content': 'line1\nline2\nline3\nline4\n'}
    @contextmanager
    def cursor(): yield Cursor()
    monkeypatch.setattr(tools.db,'get_cursor',cursor)
    output = tools._read_file('repo','src/long.py',{},start_line=2,max_lines=2)
    assert output.touched_files == ['src/long.py']
    assert 'line2\nline3' in output.content
    assert 'line1' not in output.content
    assert 'Partial file' in output.content


def test_tool_adapters_provide_source_artifacts(monkeypatch):
    from app import tools as impl
    monkeypatch.setattr(impl, 'execute', lambda name,args,repo,cache: impl.ToolResult(
        'file source', ['src/a.py']))
    wrappers = langchain_tools.build_tools('repo', {})
    result = wrappers[0].invoke({'path':'src/a.py'})
    # Tool.invoke outside ToolNode may return raw content only; the response
    # contract is recorded in its response_format and wrapper return tuple.
    assert wrappers[0].response_format == 'content_and_artifact'
    assert result == 'file source' or isinstance(result, ToolMessage)
