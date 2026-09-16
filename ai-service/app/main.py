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
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from uuid import UUID

from . import config, db, embedding, context_retrieval, agent_graph, rag, llm_client, evaluation, code_assist

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("legacybridge.ai-service")

app = FastAPI(title="AI Legacy Bridge - AI Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    db.init_pool()
    log.info(
        "AI service started — model=%s, base_url=%s, embedding_provider=%s, graph_enabled=%s",
        config.LLM_MODEL, config.LLM_BASE_URL, config.EMBEDDING_PROVIDER, bool(config.NEO4J_PASSWORD),
    )


# --- /api/ai/ask -------------------------------------------------------

class AskRequest(BaseModel):
    """Mirrors ai/dto/AskRequest.java, plus sessionId (new) for multi-turn memory."""
    repositoryId: UUID
    question: str = Field(min_length=1)
    focusedNode: str | None = None
    openFilePath: str | None = None
    # Scopes conversation memory (see agent_graph.py's MemorySaver). Two
    # requests with the same sessionId see each other's history. Defaults
    # to the repository id if omitted, so out-of-the-box every question
    # about one repo remembers the ones before it — pass a fresh UUID per
    # browser tab/session if you want isolated conversations instead.
    sessionId: str | None = None


class AskResponse(BaseModel):
    """Mirrors ai/dto/AskResponse.java."""
    answer: str
    agentUsed: str = "general"
    sourceFiles: list[str] = []


@app.post("/api/ai/ask", response_model=AskResponse)
def ask(request: AskRequest):
    repository_id = str(request.repositoryId)
    thread_id = request.sessionId or repository_id

    try:
        question_embedding = embedding.embed(request.question)

        context = context_retrieval.retrieve(
            repository_id, request.focusedNode, request.openFilePath,
            request.question, question_embedding,
        )

        result = agent_graph.run(repository_id, context.to_prompt_text(), request.question, thread_id)

    except llm_client.LlmError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        log.exception("ask() failed for repository %s", repository_id)
        raise HTTPException(status_code=500, detail=f"AI Explorer request failed: {e}")

    source_files: list[str] = []
    if context.primary_file:
        source_files.append(context.primary_file.path)
    for f in context.matched_files:
        if f.path not in source_files:
            source_files.append(f.path)
    for chunk in context.similar_chunks:
        if chunk["file_path"] not in source_files:
            source_files.append(chunk["file_path"])
    for path in result["touched_files"]:
        if path not in source_files:
            source_files.append(path)

    return AskResponse(answer=result["answer"], agentUsed="general", sourceFiles=source_files)


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
        count = rag.index_repository(str(repository_id))
    except Exception as e:
        log.exception("indexing failed for repository %s", repository_id)
        raise HTTPException(status_code=500, detail=f"Indexing failed: {e}")

    return IndexResponse(repositoryId=repository_id, chunksIndexed=count)


# --- /evaluate -----------------------------------------------------------

class EvaluateRequest(BaseModel):
    question: str
    contextText: str
    answer: str


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
        result = evaluation.evaluate_answer(request.question, request.contextText, request.answer)
    except Exception as e:
        log.exception("evaluate() failed")
        raise HTTPException(status_code=500, detail=f"Evaluation failed: {e}")

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
    functionName: str = Field(min_length=1)
    filePath: str = ""
    code: str | None = None


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
    except llm_client.LlmError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=502, detail=f"Model returned an unparseable response: {e}")
    except Exception as e:
        log.exception("generate_tests() failed for %s", request.functionName)
        raise HTTPException(status_code=500, detail=f"Test generation failed: {e}")


# --- /api/code/suggest-migration -----------------------------------------

class SuggestMigrationRequest(BaseModel):
    filePath: str = Field(min_length=1)
    code: str | None = None


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
    except llm_client.LlmError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=502, detail=f"Model returned an unparseable response: {e}")
    except Exception as e:
        log.exception("suggest_migration() failed for %s", request.filePath)
        raise HTTPException(status_code=500, detail=f"Migration suggestion failed: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=config.PORT, reload=False)
