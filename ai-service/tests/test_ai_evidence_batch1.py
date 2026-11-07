"""Batch 1: source-grounding, freshness and retrieval prompt limits."""
from contextlib import contextmanager

from app import context_retrieval, tools


def test_ranked_chunks_are_actually_given_to_the_llm():
    ctx = context_retrieval.RetrievedContext(
        all_file_paths=["src/a.py"], primary_file=None, matched_files=[],
        focused_node=None, focused_files=[],
        similar_chunks=[{"file_path": "src/a.py", "function_name": "calculate",
                         "content": "def calculate(): return 123", "similarity": 0.85}],
    )
    prompt = ctx.to_prompt_text()
    assert "def calculate(): return 123" in prompt
    assert "src/a.py :: calculate" in prompt
    assert "UNTRUSTED" in prompt


def test_prompt_boundaries_and_no_false_full_source_claim():
    ctx = context_retrieval.RetrievedContext(
        all_file_paths=[f"file{i}.py" for i in range(400)],
        primary_file=context_retrieval.PrimaryFile("big.py", "x" * 30000),
        matched_files=[], focused_node="big.py", focused_files=[],
        similar_chunks=[{"file_path": "small.py", "function_name": "small",
                         "content": "a" * 4000}],
    )
    prompt = ctx.to_prompt_text()
    assert "100 additional file paths omitted" in prompt
    assert "[Source truncated" in prompt
    assert "[Excerpt truncated" in prompt
    assert len(prompt) < 40000
    assert "COMPLETE, CURRENT source" not in prompt


def test_read_file_always_refetches_and_does_not_reuse_cross_request_cache(monkeypatch):
    data = iter(["old source", "new source"])
    count = []

    class Cursor:
        def execute(self, sql, params):
            count.append((sql, params))
        def fetchone(self):
            return {"content": next(data)}

    @contextmanager
    def fake_cursor(*args, **kwargs):
        yield Cursor()

    monkeypatch.setattr(tools.db, "get_cursor", fake_cursor)
    cache = {}
    one = tools._read_file("repo-1", "src/a.py", cache)
    two = tools._read_file("repo-1", "src/a.py", cache)
    assert one.content == "old source"
    assert two.content == "new source"
    assert len(count) == 2
    assert one.touched_files == two.touched_files == ["src/a.py"]
