"""Repository-bound LangChain tool adapters.

ToolNode returns each tool's actual artifact with its ToolMessage.  This
avoids the previous workaround that executed search_code/read_file a *second*
time merely to reconstruct source references (extra embeddings and I/O).
"""
import json as _json
from langchain_core.tools import tool
from . import tools as impl


def _as_tool_response(result):
    # LangChain's `content_and_artifact` contract: visible response string
    # plus metadata carried on the corresponding ToolMessage.
    return result.content, {"touched_files": list(dict.fromkeys(result.touched_files))}


def build_tools(repository_id: str, cache: dict):
    @tool(response_format="content_and_artifact")
    def read_file(path: str, start_line: int = 1, max_lines: int = 250) -> tuple[str, dict]:
        """Read current source of a repository file by exact path. Supports 1-based
        start_line and a bounded max_lines window for large files. Use this to
        inspect real source instead of guessing implementations."""
        return _as_tool_response(impl.execute(
            "read_file", _json.dumps({"path": path, "start_line": start_line,
                                      "max_lines": max_lines}), repository_id, cache))

    @tool(response_format="content_and_artifact")
    def search_code(query: str) -> tuple[str, dict]:
        """Find semantically similar code snippets within the current repository.
        Returns actual source snippets and their paths; follow with read_file
        when more detail is required."""
        return _as_tool_response(impl.execute(
            "search_code", _json.dumps({"query": query}), repository_id, cache))

    @tool(response_format="content_and_artifact")
    def list_files(directory: str = "") -> tuple[str, dict]:
        """List stored repository files, optionally scoped to a directory prefix.
        Does not read source code and should not be cited as code evidence."""
        return _as_tool_response(impl.execute(
            "list_files", _json.dumps({"directory": directory}), repository_id, cache))

    @tool(response_format="content_and_artifact")
    def get_dependencies(filePath: str) -> tuple[str, dict]:
        """Read immediate imports and dependencies for a repository file/node.
        Graph edges are structural metadata, not source-code quotations."""
        return _as_tool_response(impl.execute(
            "get_dependencies", _json.dumps({"filePath": filePath}), repository_id, cache))

    return [read_file, search_code, list_files, get_dependencies]


def collect_touched_files(tool_name: str, args_json: str, repository_id: str, cache: dict) -> list[str]:
    """Deprecated compatibility helper; never call after ToolNode execution.

    Kept for consumers calling this utility explicitly. Agent source tracking
    uses ToolMessage.artifact and does not call this function.
    """
    return impl.execute(tool_name, args_json, repository_id, cache).touched_files
