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
from . import db, embedding, rag, source_safety

MAX_TOOL_SOURCE_CHARS = 40000
MAX_READ_LINES = 400
MAX_LIST_PATHS = 300
MAX_DEPENDENCIES = 150


@dataclass
class ToolResult:
    content: str
    touched_files: list[str] = field(default_factory=list)


def execute(name: str, arguments_json: str, repository_id: str, cache: dict) -> ToolResult:
    try:
        args = json.loads(arguments_json) if arguments_json and arguments_json.strip() else {}
    except Exception:
        return ToolResult(content="Tool call failed: invalid arguments JSON")

    try:
        if name == "read_file":
            return _read_file(repository_id, args.get("path"), cache,
                              args.get("start_line", 1), args.get("max_lines", 250))
        if name == "search_code":
            return _search_code(repository_id, args.get("query"))
        if name == "list_files":
            return _list_files(repository_id, args.get("directory"))
        if name == "get_dependencies":
            return _get_dependencies(repository_id, args.get("filePath"))
        return ToolResult(content=f"Unknown tool: {name}")
    except Exception as e:
        return ToolResult(content=f"Tool call failed ({type(e).__name__}); check the service logs")


def _read_file(repository_id: str, path: str | None, cache: dict,
               start_line: int = 1, max_lines: int = 250) -> ToolResult:
    if not source_safety.is_valid_repo_path(path):
        return ToolResult(content="A valid relative repository path is required")
    if source_safety.is_sensitive_path(path):
        return ToolResult(content="Sensitive file contents cannot be sent to the hosted AI model")
    if not isinstance(start_line, int) or start_line < 1:
        return ToolResult(content="start_line must be a positive integer")
    if not isinstance(max_lines, int) or not (1 <= max_lines <= MAX_READ_LINES):
        return ToolResult(content=f"max_lines must be between 1 and {MAX_READ_LINES}")

    # Never serve cached source across repository re-ingestion. Compiled
    # LangGraph tools may outlive a particular request, so a dict captured
    # in their closure is not a safe cache for mutable source files.

    with db.get_cursor() as cur:
        cur.execute(
            "SELECT content FROM files WHERE repository_id = %s AND path = %s",
            (repository_id, path),
        )
        row = cur.fetchone()

    if not row:
        return ToolResult(content=f"No file found at path: {path}")

    content = row["content"] or "(no content stored for this file)"
    lines = content.splitlines(keepends=True)
    start = start_line - 1
    if start >= len(lines) and lines:
        return ToolResult(content=f"No lines at or after {start_line}; file has {len(lines)} lines")
    selected = "".join(lines[start:start + max_lines]) if lines else content
    truncated = len(selected) > MAX_TOOL_SOURCE_CHARS
    selected = selected[:MAX_TOOL_SOURCE_CHARS] if truncated else selected
    more = start + max_lines < len(lines) or truncated
    if more:
        selected += (f"\n[Partial file: lines starting at {start_line}; "
                     f"{len(lines)} total lines. Use read_file with a later "
                     "start_line to continue.]\n")
    return ToolResult(content=source_safety.redact_text(selected), touched_files=[path])


def _search_code(repository_id: str, query: str | None) -> ToolResult:
    if not isinstance(query, str) or not query.strip():
        return ToolResult(content="query is required")

    if len(query) > 4000:
        return ToolResult(content="Search query is too long")
    vec = embedding.embed(query)
    chunks = rag.find_similar(repository_id, vec, top_k=6)
    if not chunks:
        return ToolResult(content="No matching code found.")

    parts = []
    touched = []
    for c in chunks:
        path = c.get("file_path", "")
        if not source_safety.is_valid_repo_path(path) or source_safety.is_sensitive_path(path):
            continue
        header = f"--- {path}"
        if c.get("class_name"):
            header += f" (class {c['class_name']})"
        header += f" :: {c.get('function_name')} [similarity {c['similarity']:.2f}] ---"
        excerpt = source_safety.redact_text((c.get("content") or "")[:4500])
        parts.append(f"{header}\n{excerpt}\n")
        touched.append(path)

    return ToolResult(content="\n".join(parts) if parts else "No permitted code evidence found.", touched_files=touched)


def _list_files(repository_id: str, directory: str | None) -> ToolResult:
    with db.get_cursor() as cur:
        cur.execute(
            "SELECT path FROM files WHERE repository_id = %s ORDER BY path",
            (repository_id,),
        )
        paths = [r["path"] for r in cur.fetchall()]

    paths = [p for p in paths if not source_safety.is_sensitive_path(p)]
    if directory:
        if not source_safety.is_valid_repo_path(directory):
            return ToolResult(content="A valid relative directory is required")
        if source_safety.is_sensitive_path(directory):
            return ToolResult(content="Sensitive directories are excluded")
        prefix = directory.rstrip("/") + "/"
        paths = [p for p in paths if p.startswith(prefix)]

    if not paths:
        suffix = f" under {directory}" if directory else ""
        return ToolResult(content=f"No files found{suffix}")

    output = "\n".join(paths[:MAX_LIST_PATHS])
    if len(paths) > MAX_LIST_PATHS:
        output += f"\n[{len(paths) - MAX_LIST_PATHS} more files; narrow directory]"
    return ToolResult(content=output)


def _get_dependencies(repository_id: str, file_path: str | None) -> ToolResult:
    if not source_safety.is_valid_repo_path(file_path):
        return ToolResult(content="A valid relative filePath is required")
    if source_safety.is_sensitive_path(file_path):
        return ToolResult(content="Sensitive file paths are excluded")

    with db.get_cursor() as cur:
        cur.execute(
            "SELECT source, target, type FROM dependencies "
            "WHERE repository_id = %s AND (source = %s OR target = %s)",
            (repository_id, file_path, file_path),
        )
        deps = cur.fetchall()

    if not deps:
        return ToolResult(content=f"No dependencies found for {file_path}")

    deps = [d for d in deps if not source_safety.is_sensitive_path(d['source'])
            and not source_safety.is_sensitive_path(d['target'])]
    lines = [f"{d['source']} -> {d['target']} ({d['type']})" for d in deps[:MAX_DEPENDENCIES]]
    if len(deps) > MAX_DEPENDENCIES:
        lines.append(f"[{len(deps) - MAX_DEPENDENCIES} more dependencies omitted]")
    return ToolResult(content="\n".join(lines))
