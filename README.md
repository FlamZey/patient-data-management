# patient-data-management

Full-stack role-based authentication and secure patient management system built with Next.js (TypeScript + Tailwind) frontend, FastAPI + SQLAlchemy backend, PostgreSQL database, all run via Docker Compose.

## Prerequisites

- Docker + Docker Compose

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

- Frontend: <http://localhost:3000>
- Backend docs (Swagger UI): <http://localhost:8000/docs>
- Postgres: localhost:5432

## Environment configuration

Set in `.env` (created via `cp .env.example .env` above); every variable has a working local default except `SECRET_KEY`, which must be a real random value outside local dev.

- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — credentials for the `db` container.
- `DATABASE_URL` — backend's connection string; must match the Postgres credentials above.
- `SECRET_KEY` — signs JWT access tokens; anyone with it can forge one.
- `ALGORITHM` — JWT signing algorithm (`HS256`).
- `ACCESS_TOKEN_EXPIRE_MINUTES` — access token lifetime.
- `REFRESH_TOKEN_EXPIRE_DAYS` — refresh token lifetime (safe to be longer; refresh tokens are revocable, see `docs/security.md`).
- `NEXT_PUBLIC_API_URL` — backend URL the browser calls; exposed to the client bundle, so never put a secret in a `NEXT_PUBLIC_` variable.

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

```text
frontend/   Next.js app (App Router, TypeScript, Tailwind)
backend/    FastAPI app (SQLAlchemy models, Alembic migrations)
docs/       Architecture, API, database, and security notes
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
