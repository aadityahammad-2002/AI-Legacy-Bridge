## Quick Start with Docker

Docker Compose runs React/Nginx, Spring Boot/Java 21, Python/FastAPI and
PostgreSQL 18/pgvector together. Neo4j GraphRAG is optional.

```powershell
Copy-Item .env.example .env
notepad .env  # set POSTGRES_PASSWORD and LEGACYBRIDGE_LLM_API_KEY
docker compose up --build -d
```

Open **http://localhost:5173**. To enable optional Neo4j, set
`NEO4J_PASSWORD` in `.env` and use `docker compose --profile graph up --build -d`.

For configuration, local testing, ports, cleanup, persistence and warnings,
see [DOCKER_SETUP.md](DOCKER_SETUP.md).

> Root `.env` contains secrets and must never be committed. Docker runs with a
> new PostgreSQL volume; your existing local Windows database is not imported.
