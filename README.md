# patient-data-management

Full-stack role-based authentication and secure patient management system built with Next.js (TypeScript + Tailwind) frontend, FastAPI + SQLAlchemy backend, PostgreSQL database, all run via Docker Compose.

## Prerequisites

- Docker + Docker Compose
- Node.js 20+ (only needed to run the [end-to-end tests](#end-to-end-tests), which run on the host rather than in a container)

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

- Frontend: <http://localhost:3000>
- Backend docs (Swagger UI): <http://localhost:8000/docs>
- Postgres: localhost:5432

Then apply migrations and (optionally) seed demo data — see the sections below — and log in at <http://localhost:3000/login> with one of the [demo accounts](#seeding-demo-data).

## Environment configuration

Set in `.env` (created via `cp .env.example .env` above); every variable has a working local default except `SECRET_KEY` (must be a real random value outside local dev) and `PATIENT_ENCRYPTION_KEYS` (the placeholder isn't a valid key at all — the app will fail the first time it tries to encrypt or decrypt a patient field until it's replaced with a generated one).

- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — credentials for the `db` container.
- `DATABASE_URL` — backend's connection string; must match the Postgres credentials above.
- `SECRET_KEY` — signs JWT access tokens; anyone with it can forge one. Generate a real one rather than using the placeholder in `.env.example`:

  ```bash
  docker compose exec backend python scripts/generate_secret_key.py
  ```

  Rotating it invalidates every outstanding access and refresh token, signing everyone out.
- `ALGORITHM` — JWT signing algorithm (`HS256`).
- `ACCESS_TOKEN_EXPIRE_MINUTES` — access token lifetime.
- `REFRESH_TOKEN_EXPIRE_DAYS` — refresh token lifetime (safe to be longer; refresh tokens are revocable, see `docs/security.md`).
- `PATIENT_ENCRYPTION_KEYS` — JSON object mapping key version -> base64-encoded 32-byte key, used to encrypt patient PHI at rest (see `docs/security.md`). Generate a real one rather than using the placeholder in `.env.example`:

  ```bash
  docker compose exec backend python scripts/generate_encryption_key.py
  ```

  Paste the output in as `{"1": "<generated-key>"}`. When rotating keys, add a new version rather than replacing the old one, so previously-encrypted data stays readable — see the comment above this variable in `.env.example`.
- `PATIENT_ENCRYPTION_ACTIVE_VERSION` — which key version in `PATIENT_ENCRYPTION_KEYS` new writes use.
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

## Usage

Once seeded, log in at <http://localhost:3000/login> with any demo account. What you can do depends on your role:

- **admin** (`admin.us@example.com`) — full access: manage users at `/manage-users`, and view/edit every manager's patient uploads.
- **manager** (e.g. `manager.in@example.com`) — upload patient records (an `.xlsx` workbook) and view/search/edit/delete only the patients *they* uploaded, from the `/dashboard` patient table and the analytics charts on it.
- **user** (e.g. `user.us@example.com`) — no `patient.*` or `user.*` permissions by default; can sign in and view their own profile at `/settings`.

Every account can update their own name and password at `/settings`. See `docs/api-documentation.md` for the full REST API this UI calls, and `docs/security.md` for how access is scoped per role and per uploader.

## Sample patient upload files

`docs/samples/` has ready-to-use `.xlsx` files for exercising the patient upload feature — a fully valid file, and one edge case each for a missing column, a bad date/invalid gender, and a duplicate Patient ID — plus the blank template the upload UI links to. Regenerate them after changing the upload validation rules:

```bash
docker compose exec backend python -m scripts.generate_sample_workbooks
```

## Project layout

```text
frontend/   Next.js app (App Router, TypeScript, Tailwind)
backend/    FastAPI app (SQLAlchemy models, Alembic migrations)
docs/       Architecture, API, database, and security notes
docker-compose.yml   Wires db + backend + frontend together
```

## Documentation

Deeper docs live under `docs/`:

- [`docs/architecture.md`](docs/architecture.md) — the reasoning behind major design decisions (auth token split, RBAC, soft delete, patient search, patient scoping, de-identified analytics).
- [`docs/security.md`](docs/security.md) — password/token handling, login abuse protection, patient PHI encryption, upload validation, rate limits, audit logging, and known limitations.
- [`docs/api-documentation.md`](docs/api-documentation.md) — every REST endpoint, request/response shapes, and status codes. Also available as interactive Swagger UI at `/docs` once the backend is running.
- [`docs/database-schema.md`](docs/database-schema.md) — every table, column, and relationship.

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
