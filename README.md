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

Tables are managed by Alembic, not created automatically. After the containers are up:

```bash
docker compose exec backend alembic revision --autogenerate -m "create initial schema"
docker compose exec backend alembic upgrade head
```

`--autogenerate` diffs your SQLAlchemy models (`app/models.py`) against the current DB schema and writes a migration file in `backend/alembic/versions/`. `upgrade head` applies it.

## Project layout

```
frontend/   Next.js app (App Router, TypeScript, Tailwind)
backend/    FastAPI app (SQLAlchemy models, Alembic migrations)
docker-compose.yml   Wires db + backend + frontend together
```

## Running tests

### Backend

One-time setup (creates the isolated test database):
```bash
docker compose exec db psql -U user -d appdb -c "CREATE DATABASE test_appdb;"
```

Run tests:
```bash
docker compose exec backend pytest -v
docker compose exec backend pytest --cov=app --cov-report=term-missing
```

### Frontend (component tests)

```bash
docker compose exec frontend npm test
docker compose exec frontend npm run test:coverage
```

### End-to-end tests

Playwright needs a real browser, so this runs on your host machine rather than inside Docker. Make sure `docker compose up` is running in another terminal first.

```bash
cd frontend
npm install
npx playwright install
npm run test:e2e
```
