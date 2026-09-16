"""
Context retrieval. Gathers the up-front context for a question: the open
file (if any), files mentioned by name in the question text, focused-node
dependency neighborhood, and vector-similar chunks.

The focused-node neighborhood and the "similar chunks" ranking now both go
through graph_rag.py (Neo4j-backed) instead of a hardcoded 2-level Python
loop over Postgres rows — see graph_rag.py's docstring for why combining
vector + graph signals produces better context than treating them as two
unrelated retrieval paths.
"""
import re
from dataclasses import dataclass, field
from . import db, graph_rag

VECTOR_TOP_K = 8

# matches things like "FileEntity.java", "orchestrator.js", "schema.sql"
FILENAME_PATTERN = re.compile(r"\b[\w-]+\.[a-zA-Z0-9]{1,6}\b")


@dataclass
class PrimaryFile:
    path: str
    content: str | None


@dataclass
class RetrievedContext:
    all_file_paths: list[str]
    primary_file: PrimaryFile | None
    matched_files: list[PrimaryFile]
    focused_node: str | None
    focused_files: list[str]
    similar_chunks: list[dict]

    def to_prompt_text(self) -> str:
        parts = ["=== REPOSITORY OVERVIEW ===",
                 f"Total files: {len(self.all_file_paths)}",
                 "Full file list:"]
        parts.extend(f"  {p}" for p in self.all_file_paths)
        parts.append("")

        if self.primary_file:
            parts.append(f"=== PRIMARY FILE (currently open in the editor: {self.primary_file.path}) ===")
            parts.append(_format_file_content(self.primary_file))

        for mf in self.matched_files:
            parts.append(f"=== FILE MENTIONED IN THE QUESTION: {mf.path} ===")
            parts.append(_format_file_content(mf))

        if self.focused_node:
            parts.append(f"Focused on: {self.focused_node}")
            parts.append("Related files (graph neighborhood, via Neo4j): "
                          + ", ".join(self.focused_files))
            parts.append("")

        parts.append("(Use the search_code tool if you need to find relevant code by meaning "
                      "— it isn't pre-loaded here.)\n")
        return "\n".join(parts)


def _format_file_content(file: PrimaryFile) -> str:
    if file.content and file.content.strip():
        return ("This is the COMPLETE, CURRENT source of this file. Treat it as authoritative.\n\n"
                f"{file.content}\n")
    return "(This file's full source was not available in storage.)\n"


def retrieve(repository_id: str, focused_node: str | None, open_file_path: str | None,
             question: str, question_embedding: list[float]) -> RetrievedContext:

    with db.get_cursor() as cur:
        cur.execute(
            "SELECT path FROM files WHERE repository_id = %s ORDER BY path",
            (repository_id,),
        )
        all_file_paths = [r["path"] for r in cur.fetchall()]

    primary_file: PrimaryFile | None = None
    if open_file_path:
        with db.get_cursor() as cur:
            cur.execute(
                "SELECT path, content FROM files WHERE repository_id = %s AND path = %s",
                (repository_id, open_file_path),
            )
            row = cur.fetchone()
        if row:
            primary_file = PrimaryFile(path=row["path"], content=row["content"])

    matched_files = _find_files_mentioned_in_question(repository_id, question, primary_file)

    # Graph neighborhood via Neo4j (see graph_store.get_neighborhood) — a
    # single variable-length Cypher query, no hardcoded hop-count loop.
    focused_files: list[str] = []
    if focused_node:
        focused_files = graph_rag.get_structural_neighborhood(repository_id, focused_node)

    # Vector search re-ranked with a graph-distance bonus relative to
    # whichever file the user is anchored to (open file, else focused
    # node) — see graph_rag.py's docstring.
    anchor_path = open_file_path or focused_node
    ranked = graph_rag.retrieve_ranked_chunks(repository_id, question_embedding, anchor_path, VECTOR_TOP_K)
    similar_chunks = [
        {
            "file_path": r.file_path,
            "class_name": r.class_name,
            "function_name": r.function_name,
            "content": r.content,
            "similarity": r.similarity,
        }
        for r in ranked
    ]

    return RetrievedContext(
        all_file_paths=all_file_paths,
        primary_file=primary_file,
        matched_files=matched_files,
        focused_node=focused_node,
        focused_files=focused_files,
        similar_chunks=similar_chunks,
    )


def _find_files_mentioned_in_question(repository_id: str, question: str,
                                       primary_file: PrimaryFile | None) -> list[PrimaryFile]:
    matches: list[PrimaryFile] = []
    if not question:
        return matches

    seen_paths = {primary_file.path} if primary_file else set()

    for candidate in FILENAME_PATTERN.findall(question):
        with db.get_cursor() as cur:
            cur.execute(
                "SELECT path, content FROM files "
                "WHERE repository_id = %s AND path ILIKE %s",
                (repository_id, f"%{candidate}"),
            )
            for row in cur.fetchall():
                if row["path"] not in seen_paths:
                    seen_paths.add(row["path"])
                    matches.append(PrimaryFile(path=row["path"], content=row["content"]))

    return matches
