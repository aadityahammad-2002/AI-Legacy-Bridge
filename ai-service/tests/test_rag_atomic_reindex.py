"""Focused regression tests for RAG index replacement semantics."""
from contextlib import contextmanager

import pytest
from app import rag


class RecordingCursor:
    def __init__(self, fail_on_insert=False):
        self.statements = []
        self.fail_on_insert = fail_on_insert

    def execute(self, statement, params=None):
        normalized = " ".join(statement.split())
        self.statements.append((normalized, params))
        if self.fail_on_insert and normalized.startswith("INSERT INTO code_chunks"):
            raise RuntimeError("simulated insert failure")


@contextmanager
def cursor_context(cursor, transaction_events):
    try:
        yield cursor
        transaction_events.append("commit")
    except Exception:
        transaction_events.append("rollback")
        raise


def setup_index_mocks(monkeypatch, cursor, transaction_events, vectors=None):
    chunks = [{
        "repository_id": "repo-1", "file_path": "src/A.py", "class_name": "A",
        "function_name": "run", "content": "def run(): return 1", "metadata": {"line": 1},
    }]
    monkeypatch.setattr(rag, "_fetch_repo_data", lambda _repo_id: ([], [], [], []))
    monkeypatch.setattr(rag, "build_chunks", lambda *_args: chunks)
    monkeypatch.setattr(rag.embedding, "embed_batch", lambda _texts: vectors if vectors is not None else [[0.1, 0.2]])

    @contextmanager
    def get_cursor(dict_rows=True):
        assert dict_rows is False
        with cursor_context(cursor, transaction_events):
            yield cursor

    monkeypatch.setattr(rag.db, "get_cursor", get_cursor)
    monkeypatch.setattr(rag.config, "NEO4J_PASSWORD", "")
    return chunks


def test_delete_and_insert_share_one_transaction(monkeypatch):
    cursor = RecordingCursor()
    transaction_events = []
    setup_index_mocks(monkeypatch, cursor, transaction_events)

    assert rag.index_repository("repo-1") == 1
    sql = [statement for statement, _params in cursor.statements]
    assert sql[0].startswith("SELECT pg_advisory_xact_lock")
    assert sql[1] == "DELETE FROM code_chunks WHERE repository_id = %s"
    assert any(statement.startswith("INSERT INTO code_chunks") for statement in sql)
    assert transaction_events == ["commit"]


def test_embedding_count_mismatch_does_not_open_transaction(monkeypatch):
    cursor = RecordingCursor()
    transaction_events = []
    setup_index_mocks(monkeypatch, cursor, transaction_events, vectors=[])

    with pytest.raises(RuntimeError, match="Embedding count mismatch"):
        rag.index_repository("repo-1")
    assert cursor.statements == []
    assert transaction_events == []


def test_insert_failure_rolls_back_replacement_transaction(monkeypatch):
    cursor = RecordingCursor(fail_on_insert=True)
    transaction_events = []
    setup_index_mocks(monkeypatch, cursor, transaction_events)

    with pytest.raises(RuntimeError, match="simulated insert failure"):
        rag.index_repository("repo-1")
    assert transaction_events == ["rollback"]
