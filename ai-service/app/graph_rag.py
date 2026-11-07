"""Repository-scoped vector + optional graph distance re-ranking.

Neo4j is a derived cache of PostgreSQL dependencies. Use one batched Neo4j
query for all vector candidates; if Neo4j is disabled, missing, or fails,
fall back to a bounded PostgreSQL file dependency walk. Retrieval itself
must remain available without any graph database.
"""
import logging
import math
from dataclasses import dataclass
from . import rag, graph_store, config, dependency_graph

log = logging.getLogger("legacybridge.graph_rag")
GRAPH_BONUS_WEIGHT = 0.15
MAX_CANDIDATE_POOL = 48


@dataclass
class RankedChunk:
    file_path: str
    class_name: str | None
    function_name: str | None
    content: str
    similarity: float
    graph_distance: int | None
    combined_score: float


def _graph_bonus(distance: int | None) -> float:
    if distance is None or distance < 0:
        return 0.0
    return GRAPH_BONUS_WEIGHT / (1 + distance)


def _distances(repository_id: str, anchor_path: str | None, candidates: list[dict]):
    if not anchor_path or not candidates:
        return {}
    targets = list(dict.fromkeys(str(c["file_path"]) for c in candidates))
    distances = {anchor_path: 0} if anchor_path in targets else {}
    pending = [target for target in targets if target != anchor_path]
    if not pending:
        return distances
    if config.NEO4J_PASSWORD:
        try:
            neo4j_distances = graph_store.batch_shortest_path_distances(
                repository_id, anchor_path, pending
            )
            distances.update({p: d for p, d in neo4j_distances.items()
                              if p in pending and d is not None and 0 <= d <= dependency_graph.MAX_GRAPH_HOPS})
        except Exception as exc:
            log.warning("Neo4j ranking unavailable; falling back to PostgreSQL (%s)", type(exc).__name__)
    remaining = [p for p in pending if p not in distances]
    if remaining:
        try:
            distances.update(dependency_graph.distance_map(repository_id, anchor_path, remaining))
        except Exception as exc:
            log.warning("PostgreSQL structural ranking unavailable; using vector-only (%s)", type(exc).__name__)
    return distances


def retrieve_ranked_chunks(repository_id: str, query_embedding: list[float],
                           anchor_path: str | None, top_k: int = 8,
                           candidate_pool: int = 20) -> list[RankedChunk]:
    if top_k <= 0:
        return []
    top_k = min(top_k, MAX_CANDIDATE_POOL)
    pool = min(MAX_CANDIDATE_POOL, max(top_k, candidate_pool))
    candidates = rag.find_similar(repository_id, query_embedding, pool)
    distances = _distances(repository_id, anchor_path, candidates)
    ranked = []
    for candidate in candidates:
        try:
            similarity = float(candidate["similarity"])
        except (ValueError, TypeError):
            continue
        if not math.isfinite(similarity):
            continue
        distance = distances.get(candidate["file_path"])
        ranked.append(RankedChunk(
            file_path=candidate["file_path"],
            class_name=candidate.get("class_name"),
            function_name=candidate.get("function_name"),
            content=candidate["content"],
            similarity=similarity,
            graph_distance=distance,
            combined_score=similarity + _graph_bonus(distance),
        ))
    ranked.sort(key=lambda item: (-item.combined_score, -item.similarity, item.file_path))
    return ranked[:top_k]


def get_structural_neighborhood(repository_id: str, node_id: str) -> list[str]:
    if not node_id:
        return []
    if config.NEO4J_PASSWORD:
        try:
            neighbors = graph_store.get_neighborhood(repository_id, node_id)
            if neighbors:
                return neighbors[:dependency_graph.MAX_NEIGHBORS]
        except Exception as exc:
            log.warning("Neo4j neighborhood unavailable; falling back to PostgreSQL (%s)", type(exc).__name__)
    try:
        return dependency_graph.neighborhood(repository_id, node_id)
    except Exception as exc:
        log.warning("PostgreSQL neighborhood unavailable; returning empty neighborhood (%s)", type(exc).__name__)
        return []
