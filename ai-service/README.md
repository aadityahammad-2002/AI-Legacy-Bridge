# AI Legacy Bridge — AI Service (Python)

This service owns everything that used to live in the Java backend's `ai/`
and `rag/` packages, and has since been upgraded from a hand-rolled port
into a proper agent stack: **LangGraph** for the agent loop + multi-turn
memory, **GraphRAG** (pgvector + Neo4j) for retrieval, and a **guardrail +
evaluation** layer that didn't exist before at all.

It reads/writes the **same Postgres tables** (`schema.sql` is unchanged)
that `ingest/`, `storage/`, and `query/` still own on the Java side.

## Architecture

```
                    guardrail --(unsafe)--> refusal
                        |
                     (safe)
                        v
                 retrieve context        pgvector similarity
                  (graph_rag.py)       + Neo4j graph distance
                        |                -> combined ranking
                        v
              +-------> agent      ChatOpenAI (Groq/Gemini),
              |           |        MemorySaver-checkpointed
              |     tool_calls?
              |           v
              +------- tools       read_file / search_code /
                                    list_files / get_dependencies
                          |  no more tool_calls
                          v
                       answer
```

## What's in each module

| Module | Role |
|---|---|
| `agent_graph.py` | **LangGraph** `StateGraph` — guardrail -> agent <-> tools loop, `MemorySaver` for multi-turn memory |
| `guardrails.py` | LlamaGuard-taxonomy-style safety check (heuristic pass + LLM-as-judge) before a question reaches the agent |
| `graph_rag.py` | Combines pgvector similarity with Neo4j graph distance into one ranked context — **GraphRAG** |
| `graph_store.py` | Neo4j driver + Cypher queries; mirrors the Postgres `dependencies` table as a real graph |
| `langchain_tools.py` | The 4 tools (`read_file`, `search_code`, `list_files`, `get_dependencies`) as LangChain `@tool`s |
| `tools.py` | Actual tool execution logic (unchanged) — `langchain_tools.py` wraps this |
| `context_retrieval.py` | Open file / mentioned-file lookup, delegates ranking to `graph_rag.py` |
| `embedding.py` | Real semantic embeddings (sentence-transformers) by default, deterministic hashing fallback |
| `rag.py` | Chunking + indexing into `code_chunks` (pgvector) — now also triggers the Neo4j sync |
| `evaluation.py` | Ragas/TruLens-style faithfulness + relevance scoring (LLM-as-judge) |
| `llm_client.py` | Raw rate-limited HTTP client — still used by `guardrails.py`/`evaluation.py`'s judge calls (the main agent chat path now goes through `ChatOpenAI` inside `agent_graph.py` instead) |
| `token_budget.py` | Rolling 60s token-budget tracker, checked before every LLM call including mid-loop tool-calling turns |

**Not touched, still Java:** `ingest/`, `storage/`, `query/`.

## New capabilities vs. the original hand-rolled port

- **Multi-turn memory** — pass the same `sessionId` across requests (see
  `AskRequest.sessionId`) and the agent remembers the conversation.
  Defaults to `repositoryId` if omitted, so by default every question
  about one repo shares memory.
- **GraphRAG** — a chunk that's both semantically similar *and*
  structurally close (few hops in the dependency graph) to what the user
  is looking at now outranks one that's only similar in isolation.
- **Guardrails** — a safety check runs before every question. Fails open
  on classifier errors (a broken guardrail shouldn't take the whole
  service down) — see `guardrails.py`'s docstring if you want fail-closed
  instead.
- **Evaluation** — `POST /evaluate` for spot-checks; `python -m
  app.evaluation` for a batch/regression suite you maintain yourself.
- **Real semantic embeddings by default** — was a hashing trick, now
  `all-MiniLM-L6-v2` (auto-downloads ~90MB on first use; falls back to the
  old hashing embedding if the download/model load fails, so the service
  degrades instead of crashing).

## Setup

### 1. Python deps

```bash
pip install -r requirements.txt --break-system-packages
```

`sentence-transformers` pulls in `torch` — this is the heaviest
dependency in the stack. If you'd rather skip it, remove that line and set
`LEGACYBRIDGE_EMBEDDING_PROVIDER=hashing`.

### 2. Neo4j (optional but recommended — this is what makes GraphRAG work)

```bash
docker run -d --name legacybridge-neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/your-password-here \
  neo4j:5
```

If you skip this (leave `LEGACYBRIDGE_NEO4J_PASSWORD` unset), the service
still works — `graph_rag.py` degrades to pure vector search, same as
before this upgrade, and `context_retrieval.py`'s focused-node
neighborhood comes back empty instead of erroring.

### 3. Environment variables

```bash
# Postgres — same instance the Java backend uses
export LEGACYBRIDGE_DB_HOST=localhost
export LEGACYBRIDGE_DB_PASSWORD=root

# LLM (see the key-rotation warning below)
export LEGACYBRIDGE_LLM_API_KEY=your-key-here
export LEGACYBRIDGE_LLM_BASE_URL=https://api.groq.com/openai/v1
export LEGACYBRIDGE_LLM_MODEL=llama-3.3-70b-versatile

# Neo4j (omit LEGACYBRIDGE_NEO4J_PASSWORD entirely to run vector-only)
export LEGACYBRIDGE_NEO4J_URI=bolt://localhost:7687
export LEGACYBRIDGE_NEO4J_USER=neo4j
export LEGACYBRIDGE_NEO4J_PASSWORD=your-password-here

# Optional tuning
export LEGACYBRIDGE_EMBEDDING_PROVIDER=semantic   # or "hashing"
export LEGACYBRIDGE_GUARDRAILS_ENABLED=true
export LEGACYBRIDGE_GRAPH_HOP_LIMIT=2
```

### 4. Run it

```bash
python -m app.main
# or: uvicorn app.main:app --host 0.0.0.0 --port 8001
```

Interactive API docs at `http://localhost:8001/docs`.

### 5. Re-index existing repositories

If you already ingested repositories before this upgrade, their
`code_chunks` were built with the old hashing embedding and have no Neo4j
mirror. Re-index each one so GraphRAG and semantic search actually work:

```bash
curl -X POST http://localhost:8001/index/<repository-id>
```

## Integration points on the other two components

**Java (`ingest/IngestService.java`)** — already wired: it calls
`AiServiceClient.triggerIndexAsync(repositoryId)` after its transaction
commits, which hits `POST /index/{repositoryId}` here.

**Frontend (`api/backend.js`)** — already wired: `askAi()` calls this
service's `/api/ai/ask` (`VITE_AI_SERVICE_BASE_URL`, default
`http://localhost:8001`) instead of the Java backend. If you want to
actually use multi-turn memory from the UI, the frontend needs to start
passing a `sessionId` in the request body (e.g. one generated per browser
tab) — it doesn't yet, so today every question defaults to sharing memory
at the repository level.

## Rotate the leaked key

`backend/src/main/resources/application.properties` had a real LLM API key
committed in plaintext at one point. That key has since been removed from
the file, but if it was ever pushed to a shared/remote repo, rotate it in
the provider's console regardless — removing it from the current file
doesn't undo its exposure in git history. Never commit a real key anywhere;
use an environment variable or a gitignored `.env`.

## Known limitations (still true after this upgrade)

- **Guardrails are LLM-as-judge against LlamaGuard's taxonomy, not the
  actual Llama-Guard model.** Swap `guardrails.check_question_safety` to
  call a locally-hosted Llama-Guard-3 (e.g. via Ollama) if you want the
  real model instead of a prompt-based classifier.
- **Evaluation is a lightweight custom implementation**, not the `ragas`/
  `trulens` packages themselves (see `evaluation.py`'s docstring for why,
  and how to swap them in later).
- **Token budget tracking is process-local** — multiple instances behind a
  load balancer each track their own budget independently.
- **No auth on any endpoint**, matching the rest of the backend's current
  "fully open" state (see `backend/README.md`).
- **This sandbox couldn't fully runtime-test the LangGraph flow or Neo4j
  queries end-to-end** — no live Postgres, Neo4j, or LLM connectivity were
  available here. What WAS verified: every module imports cleanly, the
  compiled `StateGraph` has the right nodes/edges wired, the guardrail's
  heuristic layer correctly catches a real prompt-injection string, and
  the semantic-embedding fallback correctly degrades to hashing when the
  model can't be downloaded. Run this against your real Postgres/Neo4j/LLM
  before treating it as production-verified.
