#!/bin/sh
# Container entrypoint: migrate the database, sync reference data, then hand off to uvicorn (Dockerfile's CMD).
# Both run here so `docker compose up` alone yields a working app -- otherwise a fresh DB has no roles/permissions and nobody can log in.
# NOTE for real deployment: move both steps into a separate gated release job (not per-replica), wrapped in a Postgres advisory lock if replicas > 1.
set -e # fail loudly on a bad migration instead of starting against a half-built schema

echo "[entrypoint] Applying database migrations..."
alembic upgrade head

# Roles/permissions/locations/teams -- idempotent, see app/bootstrap.py. Demo users are opt-in via `python -m app.seed`, not created here.
echo "[entrypoint] Syncing reference data..."
python -m app.bootstrap

echo "[entrypoint] Starting: $*"
exec "$@" # replaces this shell as PID 1 so SIGTERM/SIGINT reach uvicorn directly instead of waiting out docker compose stop's timeout
