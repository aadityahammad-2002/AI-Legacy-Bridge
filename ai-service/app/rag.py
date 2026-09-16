"""
Port of ChunkingService.java + RagIndexingService.java. Turns rows already
saved by the Java backend's IngestService (methods/classes/dependencies
tables) into RAG chunks, embeds them, and stores them in code_chunks.

This runs AFTER the Java backend has ingested a repository — it never
touches source code directly, only the structured data the Analysis Engine
already extracted. It's triggered by POST /index/{repository_id} (see
main.py), which the Java IngestService should call instead of its old
in-process RagIndexingService.indexAsync(...) — see README.md for the exact
one-line change needed on the Java side.
"""
import logging
from . import db, embedding, config, graph_store

log = logging.getLogger("legacybridge.rag")

MAX_CHUNK_CHARS = 1500
OVERLAP_LINES = 3


def _split_if_too_large(code: str) -> list[str]:
    if len(code) <= MAX_CHUNK_CHARS:
        return [code]

    lines = code.split("\n")
    pieces: list[str] = []
    current: list[str] = []
    current_len = 0

    for line in lines:
        current.append(line)
        current_len += len(line) + 1
        if current_len >= MAX_CHUNK_CHARS:
            pieces.append("\n".join(current))
            overlap = current[max(0, len(current) - OVERLAP_LINES):]
            current = list(overlap)
            current_len = sum(len(l) + 1 for l in current)

    if current:
        pieces.append("\n".join(current))
    return pieces


def build_chunks(repository_id: str, methods: list[dict], classes: list[dict],
                  dependencies: list[dict]) -> list[dict]:
    # If a file has multiple classes, this picks one arbitrarily for
    # metadata purposes — same simplification the Java version made.
    class_by_file: dict[str, dict] = {}
    for c in classes:
        class_by_file.setdefault(c["file_path"], c)

    imports_by_file: dict[str, list[str]] = {}
    for d in dependencies:
        if d.get("type") == "import":
            imports_by_file.setdefault(d["source"], []).append(d["target"])

    chunks: list[dict] = []
    for method in methods:
        code = method.get("code")
        if not code or not code.strip():
            continue

        owning_class = class_by_file.get(method["file_path"])
        imports = imports_by_file.get(method["file_path"], [])

        base_metadata = {
            "line": method.get("line"),
            "endLine": method.get("end_line"),
            "type": method.get("type"),
            "isExported": method.get("is_exported"),
            "imports": imports,
        }

        pieces = _split_if_too_large(code)
        for i, piece in enumerate(pieces):
            metadata = dict(base_metadata)
            if len(pieces) > 1:
                metadata["part"] = i + 1
                metadata["totalParts"] = len(pieces)
            chunks.append({
                "repository_id": repository_id,
                "file_path": method["file_path"],
                "class_name": owning_class["name"] if owning_class else None,
                "function_name": method["name"],
                "content": piece,
                "metadata": metadata,
            })
    return chunks


def _fetch_repo_data(repository_id: str):
    with db.get_cursor() as cur:
        cur.execute(
            "SELECT name, file_path, line, end_line, type, is_exported, code "
            "FROM methods WHERE repository_id = %s",
            (repository_id,),
        )
        methods = cur.fetchall()

        cur.execute(
            "SELECT name, file_path FROM classes WHERE repository_id = %s",
            (repository_id,),
        )
        classes = cur.fetchall()

        cur.execute(
            "SELECT source, target, type FROM dependencies WHERE repository_id = %s",
            (repository_id,),
        )
        dependencies = cur.fetchall()

    return methods, classes, dependencies


def index_repository(repository_id: str) -> int:
    """Synchronous re-index of one repository: RAG chunks (Postgres/pgvector)
    AND the graph mirror (Neo4j) — see graph_store.sync_repository. Returns
    the number of chunks written."""
    methods, classes, dependencies = _fetch_repo_data(repository_id)

    with db.get_cursor(dict_rows=False) as cur:
        cur.execute("DELETE FROM code_chunks WHERE repository_id = %s", (repository_id,))

    chunks = build_chunks(repository_id, methods, classes, dependencies)
    if chunks:
        contents = [c["content"] for c in chunks]
        embeddings = embedding.embed_batch(contents)

        with db.get_cursor(dict_rows=False) as cur:
            for chunk, vec in zip(chunks, embeddings):
                cur.execute(
                    """
                    INSERT INTO code_chunks
                        (repository_id, file_path, class_name, function_name, content, embedding, metadata)
                    VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        chunk["repository_id"],
                        chunk["file_path"],
                        chunk["class_name"],
                        chunk["function_name"],
                        chunk["content"],
                        vec,
                        _to_json(chunk["metadata"]),
                    ),
                )
        log.info("Indexed %d RAG chunks for repository %s", len(chunks), repository_id)
    else:
        log.info("No chunks produced for repository %s (no method bodies extracted)", repository_id)

    if config.NEO4J_PASSWORD:
        try:
            graph_store.sync_repository(repository_id)
        except Exception as e:
            # Graph sync failing must not fail the whole index request —
            # AI Explorer just loses the GraphRAG bonus/neighborhood for
            # this repository until Neo4j is reachable again.
            log.error("Neo4j sync failed for repository %s: %s", repository_id, e)
    else:
        log.info("LEGACYBRIDGE_NEO4J_PASSWORD not set — skipping graph sync (vector-only mode)")

    return len(chunks)


def _to_json(value) -> str:
    import json
    try:
        return json.dumps(value)
    except Exception:
        return "{}"


def find_similar(repository_id: str, query_embedding: list[float], top_k: int) -> list[dict]:
    """Cosine-similarity nearest-neighbor search, scoped by repository_id first."""
    import numpy as np
    query_vec = np.array(query_embedding, dtype=np.float32)
    with db.get_cursor() as cur:
        cur.execute(
            """
            SELECT file_path, class_name, function_name, content,
                   1 - (embedding <=> %s) AS similarity
            FROM code_chunks
            WHERE repository_id = %s
            ORDER BY embedding <=> %s
            LIMIT %s
            """,
            (query_vec, repository_id, query_vec, top_k),
        )
        return cur.fetchall()
