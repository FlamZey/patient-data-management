# patient-data-management

Full-stack role-based authentication and secure patient management system built with Next.js (TypeScript + Tailwind) frontend, FastAPI + SQLAlchemy backend, PostgreSQL database, all run via Docker Compose.

[Demo video](https://www.youtube.com/watch?v=_dsJc1HWctY)

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

Migrations and reference data (roles, permissions, locations, teams) are applied automatically on backend startup — see [Database setup](#database-setup). To log in, add the [demo accounts](#seeding-demo-data) with one more command.

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

## Database setup

`docker compose up` handles this for you. The backend container's entrypoint (`backend/docker-entrypoint.sh`) runs two steps before starting the server:

1. **Migrations** — `alembic upgrade head`. Tables are managed by Alembic, never auto-created from the models.
2. **Reference data** — `python -m app.bootstrap`, which syncs roles, permissions, the role → permission grants, locations, and teams.

Step 2 is not optional data. The migrations create empty tables, and `users.role_id` / `users.location_id` are both `NOT NULL` — so without it there are no roles to assign, no account can be created, and nobody can sign in.

Both steps are idempotent, so they run harmlessly on every container start. You can also run either by hand:

```bash
docker compose exec backend alembic upgrade head
docker compose exec backend python -m app.bootstrap
```

Two ownership rules apply, and they differ on purpose:

- **Which permissions exist** — owned by the code. `backend/app/core/permissions.py` is the source of truth, so a code retired there is deleted from the database (along with its grants) on the next sync, and a permission row added by hand is removed.
- **Which roles hold which permissions** — owned by the database. The catalog's grants are *defaults*, applied when a role is first created and never overwritten afterwards, so changing a role's access is a durable database write rather than a code change and a deploy.

The trade-off is that a permission newly added to the catalog isn't back-filled onto existing roles — someone has to grant it. To discard runtime changes and return every seeded role to its defaults:

```bash
docker compose exec backend python -m app.bootstrap --reset-grants
```

See `docs/security.md` and `docs/architecture.md`.

## Seeding demo data

Creates a handful of demo accounts for local development and the e2e suite. These share a well-known password, so this step is **development only** and is deliberately not part of startup.

```bash
docker compose exec backend python -m app.seed
```

Safe to re-run — an account is only created if its email doesn't already exist. This also syncs the reference data above first, so it's a single command that leaves you with a fully usable database.

Demo users are created with the password `ChangeMe123!` (see `DEMO_USERS` in `backend/app/seed.py` for the full list of accounts/roles).

## Usage

Once seeded, log in at <http://localhost:3000/login> with any demo account. What you can do depends on your role:

- **admin** (`admin.us@example.com`) — full access. At `/manage-users`: create accounts, edit profiles, **assign roles**, and **suspend/reactivate accounts**. At `/dashboard`: upload, view, edit, and delete patient records belonging to *any* uploader. At `/data-analysis`: the analysis report over those records. At `/audit-log`: the security/compliance trail (who did what, when, from which IP) — admin-only, and read-only for everyone.
- **manager** (e.g. `manager.in@example.com`) — at `/manage-users`, view users and edit the profile fields (name, email, username, location, team) of accounts *below* them — but *not* assign roles or change account status, which are admin-only, and not edit another manager (authority runs downward only). At `/dashboard`, upload patient records (an `.xlsx` workbook) and view/search/edit only the patients *they* uploaded; at `/data-analysis`, the analysis report over that same scoped set. Cannot delete patients, see another uploader's records, or read the audit log.
- **user** (e.g. `user.us@example.com`) — no permissions by default; can sign in and manage their own profile and password at `/settings`, and nothing else.

Those capabilities come from the role → permission grants defined in `backend/app/core/permissions.py`.

Every account can update their own name and password at `/settings`. See `docs/api-documentation.md` for the full REST API this UI calls, and `docs/security.md` for how access is scoped per role and per uploader.

## Sample patient upload files

`docs/samples/` has ready-to-use `.xlsx` files for exercising the patient upload feature — a fully valid file, and one edge case each for a missing column, a bad date/invalid gender, and a duplicate Patient ID — plus the blank template the upload UI links to. Regenerate them after changing the upload validation rules by running the script.

```bash
cd backend
python -m venv venv && venv/Scripts/pip install -r requirements.txt
venv/Scripts/python -m scripts.generate_validation_fixtures
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

- [`docs/architecture.md`](docs/architecture.md) — the reasoning behind major design decisions (auth token split, RBAC, soft delete, patient search, patient scoping, de-identified analytics, client-side statistics).
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
