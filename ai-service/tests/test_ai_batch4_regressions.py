"""Batch 4 regression tests; mocked DB/LLM, zero external calls.

These tests are for Windows' full dependency-based `python -m pytest -q` run.
The separate run_batch4_offline.py can run without LangGraph/Postgres packages.
"""
from contextlib import contextmanager
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import context_retrieval, db, main, rag, source_safety, tools

REPO = UUID("18544b30-b7a7-4122-892d-e68d2349075a")


def test_secret_literals_masked_without_destroying_variable_references():
    content = 'OPENAI_API_KEY=sk-abcdefghijk123456789\npassword: hunter2\n'
    safe = source_safety.redact_text(content)
    assert "hunter2" not in safe
    assert "sk-abcdefghijk" not in safe
    assert safe.count(source_safety.REDACTED) == 2
    assert "os.getenv" in source_safety.redact_text("api_key = os.getenv('API_KEY')")


@pytest.mark.parametrize("path", ["../x", "./foo", "src/../secret", "C:\\Windows\\secret", "/etc/passwd", "a\x00b"])
def test_bad_repository_paths_blocked(path):
    assert not source_safety.is_valid_repo_path(path)


@pytest.mark.parametrize("path", [".env", "src/.env.local", "keys/private.pem", ".ssh/id_rsa", "backend/credentials.json"])
def test_sensitive_paths_not_available_to_model(path):
    assert source_safety.is_sensitive_path(path)


def test_open_source_prompt_masks_sensitive_data():
    ctx = context_retrieval.RetrievedContext(
        all_file_paths=["app.py", "backend/.env"],
        primary_file=context_retrieval.PrimaryFile("app.py", "password='hunter2'"),
        matched_files=[], focused_node=None, focused_files=[],
        similar_chunks=[{"file_path":"app.py", "function_name":"f",
                         "content": 'secret="hunter2"'},
                        {"file_path":"backend/.env", "function_name":None,
                         "content": "OPENAI_API_KEY=sk-abcdefghijk123456789"}],
    )
    prompt = ctx.to_prompt_text()
    assert "hunter2" not in prompt
    assert "sk-abcdefghijk" not in prompt
    assert "backend/.env" not in prompt
    assert "app.py" in prompt


def test_tool_reads_source_with_database_scope_and_redacts(monkeypatch):
    recorded = []
    class Cursor:
        def execute(self, sql, params):
            recorded.append((sql, params))
        def fetchone(self):
            return {"content": 'password="hunter2"\nreturn 1'}
    @contextmanager
    def cursor(*args, **kwargs):
        yield Cursor()
    monkeypatch.setattr(tools.db, "get_cursor", cursor)
    result = tools._read_file("myrepo", "src/app.py", {}, 1, 20)
    assert result.touched_files == ["src/app.py"]
    assert "hunter2" not in result.content
    assert recorded[0][1] == ("myrepo", "src/app.py")
    recorded.clear()
    assert not tools._read_file("myrepo", "../../secret", {}).touched_files
    assert not tools._read_file("myrepo", "backend/.env", {}).touched_files
    assert not recorded


def test_context_filename_search_uses_single_bounded_sql(monkeypatch):
    recorded = []
    class Cursor:
        def execute(self, sql, params):
            recorded.append((sql, params))
        def fetchall(self):
            return [{"path": "src/main.py", "content": "def main(): pass"}]
    @contextmanager
    def cursor(*args, **kwargs):
        yield Cursor()
    monkeypatch.setattr(context_retrieval.db, "get_cursor", cursor)
    found = context_retrieval._find_files_mentioned_in_question(
        "r", "Check src/main.py", None, ["src/main.py", "tests/main.py", "backend/.env"])
    assert [p.path for p in found] == ["src/main.py"]
    assert len(recorded) == 1
    assert "path = ANY(%s::text[])" in recorded[0][0]
    assert recorded[0][1][0] == "r"


def test_ask_body_length_validation():
    with pytest.raises(ValidationError):
        main.AskRequest(repositoryId=REPO, question="x" * 4001)
    with pytest.raises(ValidationError):
        main.GenerateTestsRequest(functionName="f", code="x" * 80001)


def test_unknown_repo_index_returns_404_without_running_index(monkeypatch):
    class Cursor:
        def execute(self, sql, params):
            assert "SELECT id" in sql
            assert params == (str(REPO),)
        def fetchone(self):
            return None
    @contextmanager
    def cursor():
        yield Cursor()
    monkeypatch.setattr(main.db, "get_cursor", cursor)
    monkeypatch.setattr(main.rag, "index_repository", lambda *a: pytest.fail("should not index"))
    with pytest.raises(HTTPException) as err:
        main.index_repository(REPO)
    assert err.value.status_code == 404


def test_indexing_failure_does_not_expose_exception_text(monkeypatch):
    class Cursor:
        def execute(self, sql, params): pass
        def fetchone(self): return {"id": str(REPO)}
    @contextmanager
    def cursor(): yield Cursor()
    monkeypatch.setattr(main.db, "get_cursor", cursor)
    monkeypatch.setattr(main.rag, "index_repository", lambda *a: (_ for _ in ()).throw(
        RuntimeError("OPENAI_API_KEY=sk-super-secret-123456")))
    with pytest.raises(HTTPException) as err:
        main.index_repository(REPO)
    assert err.value.status_code == 500
    assert "super-secret" not in err.value.detail


def test_code_assist_error_response_sanitized(monkeypatch):
    monkeypatch.setattr(main.code_assist, "generate_tests", lambda *a: (_ for _ in ()).throw(
        ValueError("unparseable response api_key=secretexample")))
    with pytest.raises(HTTPException) as err:
        main.generate_tests(main.GenerateTestsRequest(functionName="forecast"))
    assert err.value.status_code == 502
    assert "secretexample" not in err.value.detail


def test_lifespan_closes_database_and_neo4j(monkeypatch):
    import asyncio
    events = []
    monkeypatch.setattr(db, "init_pool", lambda: events.append("init"))
    monkeypatch.setattr(db, "close_pool", lambda: events.append("dbclose"))
    monkeypatch.setattr(main.graph_store, "close_driver", lambda: events.append("graphclose"))
    async def go():
        async with main.lifespan(main.app):
            events.append("inside")
    asyncio.run(go())
    assert events == ["init", "inside", "graphclose", "dbclose"]


def test_ask_sources_exclude_sensitive_paths_even_from_agent_artifacts(monkeypatch):
    ctx = context_retrieval.RetrievedContext(
        all_file_paths=["src/a.py", "backend/.env"],
        primary_file=None, matched_files=[], focused_node=None, focused_files=[],
        similar_chunks=[],
    )
    class Cursor:
        def execute(self, sql, params): pass
        def fetchone(self): return {"revision": 1}
    @contextmanager
    def cursor(): yield Cursor()
    monkeypatch.setattr(main.db, "get_cursor", cursor)
    monkeypatch.setattr(main.embedding, "embed", lambda q: [0.0]*384)
    monkeypatch.setattr(main.context_retrieval, "retrieve", lambda *a: ctx)
    monkeypatch.setattr(main.agent_graph, "run", lambda *a, **k: {
        "answer":"Safe", "touched_files":["backend/.env", "src/a.py", "../../local"]})
    result = main.ask(main.AskRequest(repositoryId=REPO, question="Explain a.py"))
    assert result.sourceFiles == ["src/a.py"]
