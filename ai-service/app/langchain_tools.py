"""
LangChain-native tool definitions, wrapping the same underlying
implementations in tools.py (read_file / search_code / list_files /
get_dependencies) so LangChain's automatic schema generation
(`@tool` inspects the type hints + docstring) replaces the old hand-written
JSON schema dicts in tools.tool_definitions(). Behavior is identical —
this is a thinner, more idiomatic interface over the same logic, not a
rewrite of what the tools actually do.

Each repository's tools are built fresh per-request via build_tools() so
the repository_id and per-request cache are captured in the closure — the
model never sees repository_id as a parameter (same isolation guarantee
tools.py always had).
"""
import json as _json

from langchain_core.tools import tool
from . import tools as impl


def build_tools(repository_id: str, cache: dict):
    """Returns a list of LangChain tools bound to one repository_id + request cache."""

    @tool
    def read_file(path: str) -> str:
        """Read the full current source of one file in the repository by its exact path.
        Use when you need to see a file's complete contents beyond what's already in context."""
        return impl.execute("read_file", _json.dumps({"path": path}), repository_id, cache).content

    @tool
    def search_code(query: str) -> str:
        """Semantic search across the repository's indexed code chunks for a natural-language
        query. Returns the most relevant snippets with file/class/function names. Use this
        instead of guessing when you're not sure which file has what you need."""
        return impl.execute("search_code", _json.dumps({"query": query}), repository_id, cache).content

    @tool
    def list_files(directory: str = "") -> str:
        """List files in the repository, optionally filtered to a directory prefix. Use to
        orient yourself before reading specific files. Omit `directory` to list all files."""
        return impl.execute("list_files", _json.dumps({"directory": directory}), repository_id, cache).content

    @tool
    def get_dependencies(filePath: str) -> str:
        """Get the direct dependencies (imports/calls) into and out of a given file or node."""
        return impl.execute("get_dependencies", _json.dumps({"filePath": filePath}), repository_id, cache).content

    return [read_file, search_code, list_files, get_dependencies]


def collect_touched_files(tool_name: str, args_json: str, repository_id: str, cache: dict) -> list[str]:
    """Re-derives touched_files for a given call — LangChain tool functions
    return only a string (their content), so agent_graph.py calls this
    separately (cache hit, so effectively free) to still track sourceFiles
    for the API response the same way the old executor did."""
    return impl.execute(tool_name, args_json, repository_id, cache).touched_files