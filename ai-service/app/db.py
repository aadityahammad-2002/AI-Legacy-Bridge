"""
Thin Postgres access layer. Uses the exact same schema.sql as the Java
backend (files, classes, methods, dependencies, code_chunks) — this service
reads/writes those tables directly rather than going through the Java API,
which is what lets AI/RAG live in its own process without duplicating the
repository/ingest logic that stays in Java.
"""
import psycopg2
import psycopg2.extras
from psycopg2.pool import ThreadedConnectionPool
from contextlib import contextmanager
from pgvector.psycopg2 import register_vector

from . import config

_pool: ThreadedConnectionPool | None = None


def init_pool():
    global _pool
    if _pool is None:
        _pool = ThreadedConnectionPool(
            minconn=1,
            maxconn=10,
            host=config.DB_HOST,
            port=config.DB_PORT,
            dbname=config.DB_NAME,
            user=config.DB_USER,
            password=config.DB_PASSWORD,
        )


@contextmanager
def get_conn():
    if _pool is None:
        init_pool()
    conn = _pool.getconn()
    try:
        register_vector(conn)
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)


@contextmanager
def get_cursor(dict_rows: bool = True):
    with get_conn() as conn:
        cursor_factory = psycopg2.extras.RealDictCursor if dict_rows else None
        with conn.cursor(cursor_factory=cursor_factory) as cur:
            yield cur
