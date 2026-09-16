"""
Neo4j-backed graph store for repository dependency structure.

Why this exists: the old approach (context_retrieval.py's manual focused-
node walk) did dependency traversal with a Python loop over Postgres rows,
hardcoded to exactly 2 hops. That's exactly the kind of query a graph
database is built for — "everything within N hops of this file, in either
direction" is a single Cypher query here instead of a loop, and it isn't
hardcoded to 2 hops anymore (see config.GRAPH_HOP_LIMIT).

Postgres (`dependencies` table) stays the source of truth — Neo4j is a
derived, queryable mirror of it, synced via sync_repository(). This keeps
the Java ingest side untouched (it never needs to know Neo4j exists) while
giving the AI service a real graph engine for GraphRAG (see graph_rag.py).

Data model:
  (:File {path, repository_id})-[:DEPENDS_ON {type}]->(:File {path, repository_id})
"""
import logging
from neo4j import GraphDatabase
from . import config, db

log = logging.getLogger("legacybridge.graph")

_driver = None


def get_driver():
    global _driver
    if _driver is None:
        _driver = GraphDatabase.driver(
            config.NEO4J_URI, auth=(config.NEO4J_USER, config.NEO4J_PASSWORD)
        )
    return _driver


def close_driver():
    global _driver
    if _driver is not None:
        _driver.close()
        _driver = None


def sync_repository(repository_id: str) -> int:
    """
    Rebuilds this repository's slice of the graph from Postgres. Call this
    right after (or as part of) RAG indexing (see rag.index_repository) so
    the graph and the vector index stay in sync with each other. Returns
    the number of edges written.
    """
    with db.get_cursor() as cur:
        cur.execute(
            "SELECT source, target, type FROM dependencies WHERE repository_id = %s",
            (repository_id,),
        )
        edges = cur.fetchall()

    driver = get_driver()
    with driver.session() as session:
        session.run(
            "MATCH (f:File {repository_id: $repo_id}) DETACH DELETE f",
            repo_id=repository_id,
        )
        for edge in edges:
            session.run(
                """
                MERGE (a:File {repository_id: $repo_id, path: $source})
                MERGE (b:File {repository_id: $repo_id, path: $target})
                MERGE (a)-[r:DEPENDS_ON {type: $type}]->(b)
                """,
                repo_id=repository_id,
                source=edge["source"],
                target=edge["target"],
                type=edge["type"],
            )

    log.info("Synced %d dependency edges to Neo4j for repository %s", len(edges), repository_id)
    return len(edges)


def get_neighborhood(repository_id: str, node_id: str, hops: int | None = None) -> list[str]:
    """
    Everything reachable from node_id within `hops` steps, in EITHER
    direction (depends-on + used-by) — this is the direct replacement for
    ContextRetrievalService's old hardcoded "direct + up to 5 second-level
    nodes" loop, done properly as one variable-length Cypher path query.
    """
    hops = hops or config.GRAPH_HOP_LIMIT
    driver = get_driver()
    with driver.session() as session:
        result = session.run(
            f"""
            MATCH (start:File {{repository_id: $repo_id, path: $node_id}})
            MATCH path = (start)-[:DEPENDS_ON*1..{hops}]-(other:File)
            RETURN DISTINCT other.path AS path
            """,
            repo_id=repository_id,
            node_id=node_id,
        )
        return [record["path"] for record in result]


def get_direct_connections(repository_id: str, node_id: str) -> list[dict]:
    """1-hop only, both directions — used where the old direct-dependencies tool semantics are wanted as-is."""
    driver = get_driver()
    with driver.session() as session:
        result = session.run(
            """
            MATCH (a:File {repository_id: $repo_id})-[r:DEPENDS_ON]-(b:File {repository_id: $repo_id})
            WHERE a.path = $node_id OR b.path = $node_id
            RETURN a.path AS source, b.path AS target, r.type AS type
            """,
            repo_id=repository_id,
            node_id=node_id,
        )
        return [{"source": r["source"], "target": r["target"], "type": r["type"]} for r in result]


def shortest_path_distance(repository_id: str, from_path: str, to_path: str) -> int | None:
    """Used by graph_rag.py to score how structurally close a vector-retrieved
    chunk's file is to the file the user actually has open / asked about."""
    driver = get_driver()
    with driver.session() as session:
        result = session.run(
            """
            MATCH (a:File {repository_id: $repo_id, path: $from_path}),
                  (b:File {repository_id: $repo_id, path: $to_path}),
                  path = shortestPath((a)-[:DEPENDS_ON*..6]-(b))
            RETURN length(path) AS distance
            """,
            repo_id=repository_id,
            from_path=from_path,
            to_path=to_path,
        )
        record = result.single()
        return record["distance"] if record else None
