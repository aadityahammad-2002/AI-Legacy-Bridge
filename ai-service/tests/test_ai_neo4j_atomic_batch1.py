"""Graph sync must use one managed transaction (not implicit autocommit)."""
from contextlib import contextmanager

from app import graph_store


def test_sync_rebuilds_graph_in_one_managed_transaction(monkeypatch):
    class PgCursor:
        def execute(self, *args):
            pass
        def fetchall(self):
            return [{"source": "a.py", "target": "b.py", "type": "import"}]

    @contextmanager
    def fake_cursor():
        yield PgCursor()

    calls = []
    class Result:
        def consume(self):
            calls.append("consume")
    class Tx:
        def run(self, query, **params):
            calls.append((query, params))
            return Result()
    class Session:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return None
        def execute_write(self, fn):
            calls.append("managed_transaction")
            return fn(Tx())
        def run(self, *args, **kwargs):
            raise AssertionError("Implicit session.run must not be used for graph replacement")
    class Driver:
        def session(self):
            return Session()

    monkeypatch.setattr(graph_store.db, "get_cursor", fake_cursor)
    monkeypatch.setattr(graph_store, "get_driver", lambda: Driver())
    assert graph_store.sync_repository("repo-1") == 1
    assert calls[0] == "managed_transaction"
    assert len([x for x in calls if isinstance(x, tuple)]) == 2
