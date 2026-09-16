"""
GraphRAG: combines vector similarity search (rag.py, pgvector) with graph
structural traversal (graph_store.py, Neo4j) into a single ranked context,
instead of treating them as two separate, unrelated retrieval paths the way
the original ContextRetrievalService did (vector chunks and focused-node
dependencies were just concatenated, never cross-referenced).

The core idea: a chunk that is BOTH semantically similar to the question
AND structurally close (few hops away in the dependency graph) to whatever
the user is currently looking at is more likely to actually be relevant
than one that only scores well on one axis. This re-ranks vector hits by
combining their cosine similarity with a graph-distance bonus.
"""
import logging
from dataclasses import dataclass
from . import rag, graph_store, config

log = logging.getLogger("legacybridge.graph_rag")

# How much a graph-distance bonus can boost a chunk's score. A chunk 1 hop
# away gets close to the full bonus; further away, less; unreachable/no
# anchor available, no bonus (pure vector similarity still applies).
GRAPH_BONUS_WEIGHT = 0.15


@dataclass
class RankedChunk:
    file_path: str
    class_name: str | None
    function_name: str
    content: str
    similarity: float
    graph_distance: int | None
    combined_score: float


def _graph_bonus(distance: int | None) -> float:
    if distance is None:
        return 0.0
    if distance <= 0:
        return GRAPH_BONUS_WEIGHT
    # Decays with distance: 1 hop -> ~0.10, 2 hops -> ~0.05, 3+ -> ~0.02
    return GRAPH_BONUS_WEIGHT / (1 + distance)


def retrieve_ranked_chunks(repository_id: str, query_embedding: list[float],
                            anchor_path: str | None, top_k: int = 8,
                            candidate_pool: int = 20) -> list[RankedChunk]:
    """
    anchor_path: the file the user is currently anchored to (open file or
    focused node), used to compute graph-distance bonuses. If None, this
    is equivalent to plain vector search (no graph re-ranking possible).
    """
    # Pull a larger candidate pool than top_k so re-ranking has room to
    # promote a structurally-close-but-slightly-lower-similarity chunk
    # above a purely-similar-but-unrelated one.
    candidates = rag.find_similar(repository_id, query_embedding, candidate_pool)

    ranked: list[RankedChunk] = []
    for c in candidates:
        distance = None
        if anchor_path and config.NEO4J_PASSWORD:
            try:
                if c["file_path"] == anchor_path:
                    distance = 0
                else:
                    distance = graph_store.shortest_path_distance(
                        repository_id, anchor_path, c["file_path"]
                    )
            except Exception as e:
                # Neo4j down/unreachable shouldn't break AI Explorer — just
                # degrade to pure vector ranking for this chunk.
                log.warning("Graph distance lookup failed, degrading to vector-only: %s", e)
                distance = None

        combined = c["similarity"] + _graph_bonus(distance)
        ranked.append(RankedChunk(
            file_path=c["file_path"],
            class_name=c.get("class_name"),
            function_name=c.get("function_name"),
            content=c["content"],
            similarity=c["similarity"],
            graph_distance=distance,
            combined_score=combined,
        ))

    ranked.sort(key=lambda r: r.combined_score, reverse=True)
    return ranked[:top_k]


def get_structural_neighborhood(repository_id: str, node_id: str) -> list[str]:
    """Thin wrapper so callers (context_retrieval/agent_graph) don't need to
    know whether Neo4j is configured — degrades to empty list if not."""
    if not config.NEO4J_PASSWORD:
        return []
    try:
        return graph_store.get_neighborhood(repository_id, node_id)
    except Exception as e:
        log.warning("Graph neighborhood lookup failed: %s", e)
        return []
