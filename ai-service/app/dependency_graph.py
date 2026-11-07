"""Bounded, read-only PostgreSQL structural search for GraphRAG fallback.

The Neo4j graph is an optional mirror; PostgreSQL's repository-scoped
`dependencies` and `files` tables are authoritative.  Only edges whose two
endpoints are actual stored files participate in file-to-file traversal;
external package names must not accidentally join otherwise unrelated files.
"""
from collections import defaultdict, deque
from . import config, db

MAX_GRAPH_HOPS = 6
MAX_GRAPH_EDGES = 50000
MAX_NEIGHBORS = 60


def bounded_hops(hops=None):
    value = config.GRAPH_HOP_LIMIT if hops is None else hops
    return min(MAX_GRAPH_HOPS, max(1, int(value)))


def adjacency_for_edges(edges):
    """Build undirected file dependency adjacency from normalized file edges."""
    neighbors = defaultdict(set)
    for edge in edges:
        source, target = edge["source"], edge["target"]
        if source and target and source != target:
            neighbors[source].add(target)
            neighbors[target].add(source)
    return neighbors


def walk(adjacency, anchor: str, hops: int):
    """Shortest hop distances; protects against cycles and duplicate edges."""
    distances = {anchor: 0}
    pending = deque([anchor])
    while pending:
        current = pending.popleft()
        distance = distances[current]
        if distance >= hops:
            continue
        for neighbor in sorted(adjacency.get(current, ())):
            if neighbor not in distances:
                distances[neighbor] = distance + 1
                pending.append(neighbor)
    return distances


def _repo_adjacency(repository_id: str):
    # Join to both file endpoints. A dependency on e.g. `requests` or
    # `java.util.List` must not become a bridge between unrelated sources.
    with db.get_cursor() as cur:
        cur.execute(
            """
            SELECT d.source, d.target
            FROM dependencies d
            JOIN files src ON src.repository_id = d.repository_id AND src.path = d.source
            JOIN files dst ON dst.repository_id = d.repository_id AND dst.path = d.target
            WHERE d.repository_id = %s
            LIMIT %s
            """,
            (repository_id, MAX_GRAPH_EDGES + 1),
        )
        rows = cur.fetchall()
    if len(rows) > MAX_GRAPH_EDGES:
        # Do not report a misleading partial structural graph.
        raise RuntimeError("Repository dependency graph exceeds safe traversal limit")
    return adjacency_for_edges(rows)


def distance_map(repository_id: str, anchor: str, targets, hops=None):
    if not anchor or not targets:
        return {}
    target_set = set(targets)
    max_hops = bounded_hops(hops)
    distances = walk(_repo_adjacency(repository_id), anchor, max_hops)
    return {path: distance for path, distance in distances.items()
            if path in target_set}


def neighborhood(repository_id: str, anchor: str, hops=None):
    if not anchor:
        return []
    distances = walk(_repo_adjacency(repository_id), anchor, bounded_hops(hops))
    return [path for path, _ in sorted(distances.items(), key=lambda x: (x[1], x[0]))
            if path != anchor][:MAX_NEIGHBORS]
