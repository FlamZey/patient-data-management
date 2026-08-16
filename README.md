# patient-data-management

Full-stack role-based authentication and secure patient management system built with Next.js (TypeScript + Tailwind) frontend, FastAPI + SQLAlchemy backend, PostgreSQL database, all run via Docker Compose.

## Prerequisites

- Docker + Docker Compose

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

- Frontend: http://localhost:3000
- Backend docs (Swagger UI): http://localhost:8000/docs
- Postgres: localhost:5432

## Running database migrations

Tables are managed by Alembic, not created automatically. After the containers are up, apply the migrations:

```bash
docker compose exec backend alembic upgrade head
```

## Seeding demo data

Populates roles, locations, teams, permissions, and a handful of demo users. Safe to re-run — it only fills in whatever's missing rather than duplicating rows.

```bash
docker compose exec backend python -m app.seed
```

Demo users are created with the password `ChangeMe123!` (see `DEMO_USERS` in `backend/app/seed.py` for the full list of accounts/roles).

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
