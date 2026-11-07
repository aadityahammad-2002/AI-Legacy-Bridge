"""Ask endpoint must bind chat to repository + session + revision."""
from contextlib import contextmanager
from uuid import UUID

from app import main, context_retrieval


def test_ask_passes_revision_scoped_thread_and_grounded_chunks(monkeypatch):
    repo = UUID('18544b30-b7a7-4122-892d-e68d2349075a')
    queries = []
    class Cursor:
        def execute(self, sql, params):
            queries.append((sql, params))
        def fetchone(self):
            return {"revision": 4}
    @contextmanager
    def fake_cursor():
        yield Cursor()

    ctx = context_retrieval.RetrievedContext(
        all_file_paths=['src/file.py'], primary_file=None, matched_files=[],
        focused_node=None, focused_files=[],
        similar_chunks=[{"file_path": 'src/file.py', "function_name": 'run', "content": 'def run(): pass'}],
    )
    calls = []
    monkeypatch.setattr(main.db, 'get_cursor', fake_cursor)
    monkeypatch.setattr(main.embedding, 'embed', lambda question: [0.0] * 384)
    monkeypatch.setattr(main.context_retrieval, 'retrieve', lambda *a: ctx)
    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return {"answer": "Found run()", "touched_files": []}
    monkeypatch.setattr(main.agent_graph, 'run', fake_run)
    result = main.ask(main.AskRequest(repositoryId=repo, question='Where?', sessionId='s_chat_1'))
    assert queries[0][1] == (str(repo),)
    assert calls[0][0][3] == f'{repo}:s_chat_1'
    assert calls[0][1]['revision'] == 4
    assert 'def run(): pass' in calls[0][0][1]
    # A generic question must not present every vector candidate as cited evidence.
    assert result.sourceFiles == []


def test_delete_evicts_memory_when_neo4j_unconfigured(monkeypatch):
    repo = UUID('18544b30-b7a7-4122-892d-e68d2349075a')
    evicted = []
    monkeypatch.setattr(main.config, 'NEO4J_PASSWORD', '')
    monkeypatch.setattr(main.agent_graph, 'evict_repository', evicted.append)
    assert main.delete_repository_index(repo) is None
    assert evicted == [str(repo)]
