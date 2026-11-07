"""
AI Legacy Bridge — AI service (Python).

This process owns everything that used to live in the Java backend's `ai/`
and `rag/` packages: RAG indexing (chunk -> embed -> store, now also
mirrored into Neo4j) and the AI Explorer's agent — now a LangGraph
StateGraph (agent_graph.py) with a guardrail step, GraphRAG-ranked
retrieval (graph_rag.py), and multi-turn conversation memory. It reads/
writes the SAME Postgres tables the Java backend already created
(schema.sql is unchanged) — see db.py.

Endpoints:
  POST /api/ai/ask            - AI Explorer question answering (was AiExplorerController)
  POST /index/{repository_id} - (re)index a repository's RAG chunks + graph mirror (was
                                 RagIndexingService, triggered in-process from IngestService).
                                 The Java IngestService calls this over HTTP after it finishes
                                 saving a repository — see ingest/AiServiceClient.java.
  POST /evaluate               - run the Ragas/TruLens-style eval harness against a supplied
                                 (question, context, answer) — see evaluation.py.
  POST /api/code/generate-tests   - real unit tests for one function (Tests workspace),
                                     see code_assist.py. Stateless — no DB lookup.
  POST /api/code/suggest-migration - real legacy-pattern review for one file (Migrate
                                     workspace), see code_assist.py. Stateless — no DB lookup.
  GET  /health                - liveness check
"""
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from uuid import UUID

from . import config, db, embedding, context_retrieval, agent_graph, rag, llm_client, evaluation, code_assist, graph_store, provider_errors, source_safety

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("legacybridge.ai-service")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Acquire and reliably release shared database/graph connections."""
    db.init_pool()
    log.info(
        "AI service started — model=%s, base_url=%s, embedding_provider=%s, graph_enabled=%s",
        config.LLM_MODEL, config.LLM_BASE_URL, config.EMBEDDING_PROVIDER, bool(config.NEO4J_PASSWORD),
    )
    try:
        yield
    finally:
        try:
            graph_store.close_driver()
        finally:
            db.close_pool()


app = FastAPI(title="AI Legacy Bridge - AI Service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in config.CORS_ALLOWED_ORIGINS if origin.strip()],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


# Local safety limit: reverse proxies must independently enforce a body limit
# for public deployments, including chunked requests without Content-Length.
MAX_HTTP_BODY_BYTES = 1024 * 1024


@app.middleware("http")
async def reject_oversized_body(request: Request, call_next):
    raw_size = request.headers.get("content-length")
    if raw_size:
        try:
            if int(raw_size) > MAX_HTTP_BODY_BYTES:
                return JSONResponse(status_code=413, content={"detail": "Request body too large"})
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
    return await call_next(request)


# --- /api/ai/ask -------------------------------------------------------

class AskRequest(BaseModel):
    """Mirrors ai/dto/AskRequest.java, plus sessionId (new) for multi-turn memory."""
    repositoryId: UUID
    question: str = Field(min_length=1, max_length=4000)
    focusedNode: str | None = Field(default=None, max_length=1024)
    openFilePath: str | None = Field(default=None, max_length=1024)
    # Scopes conversation memory (see agent_graph.py's MemorySaver). Two
    # requests with the same sessionId see each other's history. Defaults
    # to the repository id if omitted, so out-of-the-box every question
    # about one repo remembers the ones before it — pass a fresh UUID per
    # browser tab/session if you want isolated conversations instead.
    sessionId: str | None = Field(default=None, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")


class AskResponse(BaseModel):
    """Mirrors ai/dto/AskResponse.java."""
    answer: str
    agentUsed: str = "general"
    sourceFiles: list[str] = []


@app.post("/api/ai/ask", response_model=AskResponse)
def ask(request: AskRequest):
    repository_id = str(request.repositoryId)
    thread_id = f"{repository_id}:{request.sessionId or 'default'}"
    if request.openFilePath and not source_safety.is_valid_repo_path(request.openFilePath):
        raise HTTPException(status_code=422, detail="Invalid relative repository file path")

    try:
        # The Java ingestion transaction increments this revision. LangGraph
        # in-memory conversations from an older revision must be discarded.
        with db.get_cursor() as cur:
            cur.execute("SELECT revision FROM repositories WHERE id = %s", (repository_id,))
            repo_row = cur.fetchone()
        if repo_row is None:
            raise HTTPException(status_code=404, detail="Repository not found")
        repo_revision = int(repo_row["revision"])
        question_embedding = embedding.embed(request.question)

        context = context_retrieval.retrieve(
            repository_id, request.focusedNode, request.openFilePath,
            request.question, question_embedding,
        )

        result = agent_graph.run(repository_id, context.to_prompt_text(),
                                 source_safety.redact_text(request.question),
                                 thread_id, revision=repo_revision)

    except HTTPException:
        raise
    except llm_client.LlmError as e:
        raise HTTPException(status_code=e.http_status, detail=str(e))
    except provider_errors.ProviderFailure as e:
        raise HTTPException(status_code=e.http_status, detail=str(e))
    except Exception as e:
        log.error("ask() failed for repository %s (%s)", repository_id, type(e).__name__)
        raise HTTPException(status_code=500, detail="AI Explorer request failed")

    source_files: list[str] = []
    known = set(context.all_file_paths)

    def add_source(path):
        if (isinstance(path, str) and path in known
                and source_safety.is_valid_repo_path(path)
                and not source_safety.is_sensitive_path(path)
                and path not in source_files):
            source_files.append(path)

    if context.primary_file:
        add_source(context.primary_file.path)
    for f in context.matched_files[:context_retrieval.MAX_MATCHED_FILES]:
        add_source(f.path)
    # Not every vector hit supports an answer.  Keep only grounded candidates
    # and actual read_file/search_code tool artifacts from this response.
    for chunk in context_retrieval.relevant_source_chunks(
        context.similar_chunks, request.question
    ):
        add_source(chunk["file_path"])
    for path in result["touched_files"]:
        add_source(path)

    return AskResponse(answer=source_safety.redact_text(result["answer"]),
                       agentUsed="general", sourceFiles=source_files)


# --- /index/{repository_id} --------------------------------------------

class IndexResponse(BaseModel):
    repositoryId: UUID
    chunksIndexed: int


@app.post("/index/{repository_id}", response_model=IndexResponse)
def index_repository(repository_id: UUID):
    """
    (Re)builds RAG chunks (Postgres/pgvector) AND the graph mirror (Neo4j,
    if configured) for a repository from whatever the Java backend has
    already saved to files/methods/classes/dependencies. Call this right
    after ingest completes (see ingest/AiServiceClient.java), or any time
    to re-index.
    """
    try:
        with db.get_cursor() as cur:
            cur.execute("SELECT id FROM repositories WHERE id = %s", (str(repository_id),))
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="Repository not found")
        count = rag.index_repository(str(repository_id))
    except HTTPException:
        raise
    except Exception as e:
        log.error("indexing failed for repository %s (%s)", repository_id, type(e).__name__)
        raise HTTPException(status_code=500, detail="Repository indexing failed; check service logs")

    return IndexResponse(repositoryId=repository_id, chunksIndexed=count)


@app.delete("/index/{repository_id}", status_code=204)
def delete_repository_index(repository_id: UUID):
    """Idempotent removal of the Neo4j mirror after Java's DB cascade delete.

    Vector chunks belong to PostgreSQL and are deleted by the Java transaction.
    Do not delete PostgreSQL rows here, as repository IDs may be re-created.
    """
    try:
        if config.NEO4J_PASSWORD:
            graph_store.delete_repository(str(repository_id))
    except Exception as e:
        log.error("graph cleanup failed for repository %s (%s)", repository_id, type(e).__name__)
        raise HTTPException(status_code=503, detail="Graph cleanup temporarily unavailable")
    finally:
        # Even if Neo4j is unavailable or not configured, deleted repositories
        # must not keep their LangGraph conversation checkpoints in memory.
        agent_graph.evict_repository(str(repository_id))
    return None


# --- /evaluate -----------------------------------------------------------

class EvaluateRequest(BaseModel):
    question: str = Field(max_length=4000)
    contextText: str = Field(max_length=60000)
    answer: str = Field(max_length=20000)


class EvaluateResponse(BaseModel):
    faithfulness: float
    relevance: float
    faithfulnessReason: str
    relevanceReason: str


@app.post("/evaluate", response_model=EvaluateResponse)
def evaluate(request: EvaluateRequest):
    """Ad-hoc single-case eval — mainly useful for spot-checking a specific
    AI Explorer answer. For batch/regression evaluation see evaluation.py's
    run_eval_suite(), meant to be run offline, not through this endpoint."""
    try:
        result = evaluation.evaluate_answer(source_safety.redact_text(request.question),
                                            source_safety.redact_text(request.contextText),
                                            source_safety.redact_text(request.answer))
    except Exception as e:
        log.error("evaluate() failed (%s)", type(e).__name__)
        raise HTTPException(status_code=500, detail="Evaluation failed; check service logs")

    return EvaluateResponse(
        faithfulness=result.faithfulness,
        relevance=result.relevance,
        faithfulnessReason=result.faithfulness_reason,
        relevanceReason=result.relevance_reason,
    )


@app.get("/health")
def health():
    return {"status": "ok"}


# --- /api/code/generate-tests -------------------------------------------

class GenerateTestsRequest(BaseModel):
    functionName: str = Field(min_length=1, max_length=256)
    filePath: str = Field(default="", max_length=1024)
    code: str | None = Field(default=None, max_length=80000)


class GenerateTestsResponse(BaseModel):
    testCode: str
    coverageEstimate: int
    notes: str = ""


@app.post("/api/code/generate-tests", response_model=GenerateTestsResponse)
def generate_tests(request: GenerateTestsRequest):
    """Real LLM-backed replacement for the frontend's buildMockTests()
    preview. Stateless — takes the function's source directly, no
    repository lookup, so it works even for a repo that was never ingested
    into the Java backend."""
    try:
        result = code_assist.generate_tests(request.functionName, request.filePath, request.code or "")
        return GenerateTestsResponse(**result)
    except HTTPException:
        raise
    except (llm_client.LlmError, provider_errors.ProviderFailure) as e:
        raise HTTPException(status_code=e.http_status, detail=str(e))
    except ValueError:
        raise HTTPException(status_code=502, detail="Model returned an invalid structured response")
    except Exception as e:
        log.error("generate_tests() failed (%s)", type(e).__name__)
        raise HTTPException(status_code=500, detail="Test generation failed; check service logs")


# --- /api/code/suggest-migration -----------------------------------------

class SuggestMigrationRequest(BaseModel):
    filePath: str = Field(min_length=1, max_length=1024)
    code: str | None = Field(default=None, max_length=80000)


class MigrationHunk(BaseModel):
    before: str
    after: str
    category: str = "Stylistic"
    severity: str = "Low"
    explanation: str = ""


class SuggestMigrationResponse(BaseModel):
    hunks: list[MigrationHunk]


@app.post("/api/code/suggest-migration", response_model=SuggestMigrationResponse)
def suggest_migration(request: SuggestMigrationRequest):
    """Real LLM-backed replacement for the frontend's buildMockMigration()
    preview. Stateless, same reasoning as generate_tests() above."""
    try:
        result = code_assist.suggest_migration(request.filePath, request.code or "")
        return SuggestMigrationResponse(**result)
    except HTTPException:
        raise
    except (llm_client.LlmError, provider_errors.ProviderFailure) as e:
        raise HTTPException(status_code=e.http_status, detail=str(e))
    except ValueError:
        raise HTTPException(status_code=502, detail="Model returned an invalid structured response")
    except Exception as e:
        log.error("suggest_migration() failed (%s)", type(e).__name__)
        raise HTTPException(status_code=500, detail="Migration suggestion failed; check service logs")


if __name__ == "__main__":
    import uvicorn
    # Bind locally by default; public deployment requires network isolation
    # and dedicated ingress controls (auth remains out of project scope).
    uvicorn.run("app.main:app", host="127.0.0.1", port=config.PORT, reload=False)
