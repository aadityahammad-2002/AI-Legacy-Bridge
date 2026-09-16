"""
Configuration for the AI Legacy Bridge AI service.

Mirrors the relevant keys from the Java backend's application.properties.
Everything is read from environment variables (with the same defaults the
Java side used) rather than a committed file — see the note in README.md
about the Groq/Gemini key that WAS committed in application.properties;
don't repeat that mistake here.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH)

# --- Database (same Postgres instance/schema.sql as the Java backend) ---
DB_HOST = os.environ.get("LEGACYBRIDGE_DB_HOST", "localhost")
DB_PORT = int(os.environ.get("LEGACYBRIDGE_DB_PORT", "5432"))
DB_NAME = os.environ.get("LEGACYBRIDGE_DB_NAME", "legacybridge")
DB_USER = os.environ.get("LEGACYBRIDGE_DB_USER", "postgres")
DB_PASSWORD = os.environ.get("LEGACYBRIDGE_DB_PASSWORD", "root")

# --- Embeddings ---
EMBEDDING_DIMENSIONS = int(os.environ.get("LEGACYBRIDGE_EMBEDDING_DIMENSIONS", "384"))
# "semantic" (default) = real sentence-transformers model, "hashing" = old
# zero-dependency deterministic fallback. See embedding.py's docstring.
EMBEDDING_PROVIDER = os.environ.get("LEGACYBRIDGE_EMBEDDING_PROVIDER", "semantic")

# --- Graph DB (Neo4j) — powers GraphRAG's structural traversal, see graph_store.py ---
NEO4J_URI = os.environ.get("LEGACYBRIDGE_NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("LEGACYBRIDGE_NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("LEGACYBRIDGE_NEO4J_PASSWORD", "")
GRAPH_HOP_LIMIT = int(os.environ.get("LEGACYBRIDGE_GRAPH_HOP_LIMIT", "2"))

# --- Guardrails ---
GUARDRAILS_ENABLED = os.environ.get("LEGACYBRIDGE_GUARDRAILS_ENABLED", "true").lower() == "true"

# --- LLM (OpenAI-compatible chat completions — Groq or Gemini's OpenAI-compat endpoint) ---
# NOTE: the Java backend's application.properties had a real key committed
# in plaintext (legacybridge.groq.api-key=...). That key should be treated
# as compromised — rotate it in the provider's console before relying on
# this service. Only ever set it here via the environment variable below.
LLM_BASE_URL = os.environ.get("LEGACYBRIDGE_LLM_BASE_URL", "https://api.groq.com/openai/v1")
LLM_API_KEY = os.environ.get("LEGACYBRIDGE_LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LEGACYBRIDGE_LLM_MODEL", "llama-3.3-70b-versatile")

# --- Rate limiting / pacing (see token_budget.py, llm_client.py) ---
MIN_GAP_BETWEEN_CALLS_SECONDS = float(os.environ.get("LEGACYBRIDGE_LLM_MIN_GAP_SECONDS", "4.5"))
CALL_TIMEOUT_SECONDS = float(os.environ.get("LEGACYBRIDGE_LLM_TIMEOUT_SECONDS", "50"))
MAX_RETRIES = int(os.environ.get("LEGACYBRIDGE_LLM_MAX_RETRIES", "2"))
MAX_RETRY_WAIT_SECONDS = float(os.environ.get("LEGACYBRIDGE_LLM_MAX_RETRY_WAIT_SECONDS", "5"))
TPM_LIMIT = int(os.environ.get("LEGACYBRIDGE_LLM_TPM_LIMIT", "200000"))
TPM_SAFETY_BUFFER = int(os.environ.get("LEGACYBRIDGE_LLM_TPM_SAFETY_BUFFER", "1500"))

# --- Server ---
PORT = int(os.environ.get("PORT", "8001"))
CORS_ALLOWED_ORIGINS = os.environ.get(
    "LEGACYBRIDGE_CORS_ALLOWED_ORIGINS", "http://localhost:5173"
).split(",")
