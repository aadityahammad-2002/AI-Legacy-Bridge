"""
Port of ai/ToolCallExecutor.java. Implements the 4 tools the agent loop can
call: read_file, search_code, list_files, get_dependencies. All scoped by
repository_id (never exposed to the model — the orchestrator injects it).

The JSON-schema tool definitions this module used to expose directly are
gone — LangChain's @tool decorator (see langchain_tools.py) now generates
those schemas automatically from type hints/docstrings. This module keeps
just the actual execution logic (execute()), which langchain_tools.py calls
into.
"""
import json
from dataclasses import dataclass, field
from . import db, embedding, rag


@dataclass
class ToolResult:
    content: str
    touched_files: list[str] = field(default_factory=list)


def execute(name: str, arguments_json: str, repository_id: str, cache: dict) -> ToolResult:
    try:
        args = json.loads(arguments_json) if arguments_json and arguments_json.strip() else {}
    except Exception as e:
        return ToolResult(content=f"Tool call failed: could not parse arguments ({e})")

    try:
        if name == "read_file":
            return _read_file(repository_id, args.get("path"), cache)
        if name == "search_code":
            return _search_code(repository_id, args.get("query"))
        if name == "list_files":
            return _list_files(repository_id, args.get("directory"))
        if name == "get_dependencies":
            return _get_dependencies(repository_id, args.get("filePath"))
        return ToolResult(content=f"Unknown tool: {name}")
    except Exception as e:
        return ToolResult(content=f"Tool call failed: {e}")


def _read_file(repository_id: str, path: str | None, cache: dict) -> ToolResult:
    if not path:
        return ToolResult(content="path is required")

    cache_key = f"read_file:{path}"
    if cache_key in cache:
        return ToolResult(content=cache[cache_key], touched_files=[path])

    with db.get_cursor() as cur:
        cur.execute(
            "SELECT content FROM files WHERE repository_id = %s AND path = %s",
            (repository_id, path),
        )
        row = cur.fetchone()

    if not row:
        return ToolResult(content=f"No file found at path: {path}")

    content = row["content"] or "(no content stored for this file)"
    cache[cache_key] = content
    return ToolResult(content=content, touched_files=[path])


def _search_code(repository_id: str, query: str | None) -> ToolResult:
    if not query:
        return ToolResult(content="query is required")

    vec = embedding.embed(query)
    chunks = rag.find_similar(repository_id, vec, top_k=6)
    if not chunks:
        return ToolResult(content="No matching code found.")

    parts = []
    touched = []
    for c in chunks:
        header = f"--- {c['file_path']}"
        if c.get("class_name"):
            header += f" (class {c['class_name']})"
        header += f" :: {c['function_name']} [similarity {c['similarity']:.2f}] ---"
        parts.append(f"{header}\n{c['content']}\n")
        touched.append(c["file_path"])

    return ToolResult(content="\n".join(parts), touched_files=touched)


def _list_files(repository_id: str, directory: str | None) -> ToolResult:
    with db.get_cursor() as cur:
        cur.execute(
            "SELECT path FROM files WHERE repository_id = %s ORDER BY path",
            (repository_id,),
        )
        paths = [r["path"] for r in cur.fetchall()]

    if directory:
        paths = [p for p in paths if p.startswith(directory)]

    if not paths:
        suffix = f" under {directory}" if directory else ""
        return ToolResult(content=f"No files found{suffix}")

    return ToolResult(content="\n".join(paths))


def _get_dependencies(repository_id: str, file_path: str | None) -> ToolResult:
    if not file_path:
        return ToolResult(content="filePath is required")

    with db.get_cursor() as cur:
        cur.execute(
            "SELECT source, target, type FROM dependencies "
            "WHERE repository_id = %s AND (source = %s OR target = %s)",
            (repository_id, file_path, file_path),
        )
        deps = cur.fetchall()

    if not deps:
        return ToolResult(content=f"No dependencies found for {file_path}")

    lines = [f"{d['source']} -> {d['target']} ({d['type']})" for d in deps]
    return ToolResult(content="\n".join(lines))
