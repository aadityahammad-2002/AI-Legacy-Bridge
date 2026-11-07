"""
Embedding generation.

Two providers, switchable via LEGACYBRIDGE_EMBEDDING_PROVIDER:

- "semantic" (default): a real trained sentence-embedding model
  (sentence-transformers, all-MiniLM-L6-v2 — 384-dim, matches the
  code_chunks.embedding vector(384) column exactly, no schema change
  needed). This actually captures semantic similarity — e.g. it knows
  "delete" and "remove" are related, which the old hashing trick did not.
  First call downloads the model (~90MB) from Hugging Face and caches it
  locally; subsequent calls are fast.

- "hashing": the original deterministic feature-hashing embedding (FNV-1a
  based "hashing trick") — available only if explicitly selected.
  Never silently fall back from semantic to hashing: mixed vector spaces
  produce confident-looking but incorrect retrieval results.

IMPORTANT: switching providers requires re-indexing every existing
repository's code_chunks — vectors from different providers are not
comparable to each other, even though they're both 384-dim.
"""
import re
import math
import logging
from . import config

log = logging.getLogger("legacybridge.embedding")

_SUB_TOKEN = re.compile(r"[a-z]+|[0-9]+")
_SPLIT = re.compile(r"[^a-z0-9]+")

_semantic_model = None
_semantic_load_failed = False


def dimensions() -> int:
    return config.EMBEDDING_DIMENSIONS


def _get_semantic_model():
    """Lazily loads the sentence-transformers model on first use, so the
    service still starts instantly even if the model hasn't been
    downloaded yet — the download only happens the first time embed() is
    actually called."""
    global _semantic_model, _semantic_load_failed
    if _semantic_model is not None:
        return _semantic_model
    if _semantic_load_failed:
        raise RuntimeError("Semantic embedding model is unavailable; restart after fixing it")
    try:
        from sentence_transformers import SentenceTransformer
        model_kwargs = ({"revision": config.EMBEDDING_MODEL_REVISION}
                        if config.EMBEDDING_MODEL_REVISION else {})
        _semantic_model = SentenceTransformer("all-MiniLM-L6-v2", **model_kwargs)
        return _semantic_model
    except Exception as e:
        _semantic_load_failed = True
        log.error("Semantic embedding model unavailable (%s); refusing mixed vector spaces",
                  type(e).__name__)
        raise RuntimeError(
            "Semantic embedding model unavailable; configure the model or explicitly "
            "set LEGACYBRIDGE_EMBEDDING_PROVIDER=hashing and reindex all repositories"
        ) from e



def _tokenize(text: str) -> list[str]:
    tokens: list[str] = []
    lower = text.lower()
    for word in _SPLIT.split(lower):
        if not word:
            continue
        tokens.append(word)
        tokens.extend(_SUB_TOKEN.findall(word))
    return tokens


def _hash_to_index(s: str, dims: int) -> int:
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h % dims


def _hash_sign(s: str) -> int:
    h = 5381
    for ch in s:
        h = (((h << 5) + h) ^ ord(ch)) & 0xFFFFFFFF
    return 1 if (h & 1) == 0 else -1


def _embed_hashing(text: str) -> list[float]:
    """The original deterministic feature-hashing embedding — see module
    docstring. Faithful port of the Java HashingEmbeddingService."""
    dims = dimensions()
    vec = [0.0] * dims
    for token in _tokenize(text or ""):
        idx = _hash_to_index(token, dims)
        vec[idx] += _hash_sign(token)

    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


def _embed_semantic(text: str) -> list[float] | None:
    model = _get_semantic_model()
    if model is None:
        return None
    vec = model.encode(text or "", normalize_embeddings=True)
    return vec.tolist()


SEMANTIC_MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
HASHING_MODEL_ID = "legacybridge/fnv1a-hashing-v1"


def model_identity() -> str:
    provider = config.EMBEDDING_PROVIDER.lower().strip()
    if provider == "semantic":
        return (SEMANTIC_MODEL_ID + "@" + config.EMBEDDING_MODEL_REVISION
                if config.EMBEDDING_MODEL_REVISION else SEMANTIC_MODEL_ID + "@unversioned")
    if provider == "hashing":
        return HASHING_MODEL_ID
    raise ValueError(f"Unsupported embedding provider: {provider!r}")


def _validate(vec: list[float]) -> list[float]:
    if len(vec) != dimensions() or any(not math.isfinite(float(x)) for x in vec):
        raise RuntimeError("Embedding vector has incorrect dimensions or non-finite values")
    return vec


def embed(text: str) -> list[float]:
    provider = config.EMBEDDING_PROVIDER.lower().strip()
    if provider == "semantic":
        vec = _embed_semantic(text)
        if vec is None:
            raise RuntimeError("Semantic model did not produce an embedding")
        return _validate(vec)
    if provider == "hashing":
        return _validate(_embed_hashing(text))
    raise ValueError(f"Unsupported embedding provider: {provider!r}")


def embed_batch(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    provider = config.EMBEDDING_PROVIDER.lower().strip()
    if provider == "semantic":
        model = _get_semantic_model()
        vecs = model.encode(texts, normalize_embeddings=True)
        return [_validate(v.tolist() if hasattr(v, "tolist") else list(v)) for v in vecs]
    if provider == "hashing":
        return [_validate(_embed_hashing(t)) for t in texts]
    raise ValueError(f"Unsupported embedding provider: {provider!r}")
