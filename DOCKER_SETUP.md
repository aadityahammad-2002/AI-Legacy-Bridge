# AI Legacy Bridge — Docker Setup

These files are an add-on to the existing GitHub source tree. They do **not**
replace the Java, Python or React application code.

## What runs

| Container | Service | Host URL |
|---|---|---|
| frontend | React build served through Nginx | http://localhost:5173 |
| backend | Java 21 Spring Boot + Flyway | http://localhost:8080 |
| ai-service | Python FastAPI + RAG/agents | http://localhost:8001 |
| postgres | PostgreSQL 18 + pgvector | Internal Docker network only |
| neo4j | Optional graph mirror (profile `graph`) | http://localhost:7474 |

Frontend calls the published Java/Python ports through the browser.
Java and Python talk to other containers via Docker service names.

## Prerequisites

1. Docker Desktop installed and running with Linux containers and Compose.
2. Copy the **contents** of this archive into the root of your existing
   `AI-Legacy-Bridge-Git` source folder. Do not make another nested folder.
3. Make sure ports 5173, 8080 and 8001 are free. Close existing local
   Vite, Java and Python servers before starting Docker.
4. Internet access for first-time images/dependencies and initial semantic
   embedding model download. First build is large (PyTorch / transformers).

## Configure once — PowerShell (Windows)

```powershell
cd "C:\Users\aadit\OneDrive\Desktop\AI-Legacy-Bridge-Git"
Copy-Item .env.example .env
notepad .env
```

Enter a strong new `POSTGRES_PASSWORD` and your actual
`LEGACYBRIDGE_LLM_API_KEY`. Do not put secrets in `.env.example`.
The root `.env` is ignored by the existing root `.gitignore`.

The Docker AI service **does not need** `ai-service/.env`: Compose supplies its
variables. Your existing `ai-service/.env` can remain for manual Windows runs.

## Start without Neo4j (recommended on 8 GB RAM)

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

Open http://localhost:5173

Check health:

```powershell
Invoke-RestMethod http://localhost:8001/health
Invoke-WebRequest http://localhost:8080/api/repository/list -UseBasicParsing | Select-Object StatusCode
docker compose logs --tail=80 backend ai-service postgres
```

The Python health endpoint tests process liveness; use the Java endpoint and
browser workflow to verify end-to-end DB/read functionality. The semantic model
is downloaded and cached on the first embedding operation.

## Enable Neo4j GraphRAG (optional)

1. Set `NEO4J_PASSWORD` to a strong password (minimum eight characters)
   in **root** `.env`.
2. Start with the graph profile:

```powershell
docker compose --profile graph up --build -d
docker compose --profile graph ps
```

Open Neo4j Browser: http://localhost:7474
Username: `neo4j` — password: `NEO4J_PASSWORD` value from root `.env`.

When the Neo4j password is blank, the Python service uses PostgreSQL/pgvector
plus its PostgreSQL dependency-graph fallback instead. When GraphRAG is enabled,
verify Neo4j readiness and re-index previously ingested repos if their graph
mirror was not created.

**Note:** Profile selection starts the optional Neo4j container; the AI service
can fall back to PostgreSQL if Neo4j is not ready yet. Don't set a nonempty
`NEO4J_PASSWORD` without starting the graph profile if you intend to use Neo4j.

## Persistent data and safe shutdown

```powershell
# No Neo4j profile:
docker compose down

# If you started Neo4j:
docker compose --profile graph down

# View logs:
docker compose logs -f

# Rebuild after source changes:
docker compose up --build -d
```

Data survives `down` in named volumes `postgres_data`, `huggingface_cache`,
and (if used) `neo4j_data`. **Do not run `docker compose down -v`** unless
intentionally deleting these volumes.

Docker uses a **new, independent PostgreSQL database**. It does not import
or modify the Windows `legacybridge` / `legacybridge_phase1_test` database.
Repositories stored in Windows PostgreSQL will not automatically appear in
Docker until migrated or re-ingested. Flyway creates/updates tables in the new
Docker DB; the one-time PostgreSQL init script enables required extensions.

## Existing settings and limitations

- `ai-service/.env` is for manual Python runs, not Docker. Keep or remove it
  locally as needed; do not commit it.
- `frontend/.env` is for Vite development; Docker builds its frontend URLs
  from Compose build arguments.
- No app source files are changed by this Docker support bundle.
- Default ports bind only to localhost. **This is a local development setup,
  not a public production deployment** (the app currently has no auth).
- Docker image/runtime integration still needs to be validated on a machine
  with Docker Desktop. This package was checked against current project
  source/configuration and syntactically validated but not booted here.
- If restarting after editing `LEGACYBRIDGE_LLM_API_KEY` or `NEO4J_PASSWORD`,
  recreate containers with `docker compose up -d` (or `--profile graph up -d`),
  not `docker compose restart`, since restart doesn't refresh environment.

## Git security check

```powershell
git check-ignore -v .env
git ls-files .env
git status --short
```

`git ls-files .env` must print nothing. Only commit `.env.example`.
