# patient-data-management

Full-stack role-based authentication and secure patient management system built with Next.js (TypeScript + Tailwind) frontend, FastAPI + SQLAlchemy backend, PostgreSQL database, all run via Docker Compose.

## Prerequisites

- Docker + Docker Compose
- (Optional, for running things outside Docker) Node.js 20+, Python 3.12+

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

- Frontend: http://localhost:3000
- Backend docs (Swagger UI): http://localhost:8000/docs
- Postgres: localhost:5432

## Running database migrations

The `items` table (and any future tables) is managed by Alembic, not created automatically. After the containers are up:

```bash
docker compose exec backend alembic revision --autogenerate -m "create items table"
docker compose exec backend alembic upgrade head
```

`--autogenerate` diffs your SQLAlchemy models (`app/models.py`) against the current DB schema and writes a migration file in `backend/alembic/versions/`. `upgrade head` applies it.

## Project layout

```
frontend/   Next.js app (App Router, TypeScript, Tailwind)
backend/    FastAPI app (SQLAlchemy models, Alembic migrations)
docker-compose.yml   Wires db + backend + frontend together
```
