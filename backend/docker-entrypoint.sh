#!/bin/sh
# Container entrypoint: bring the database in line with this image's code,
# then hand off to the real command (uvicorn, per the Dockerfile's CMD).
#
# Both steps run here so that `docker compose up` alone yields a working
# application. Previously they were manual follow-up commands, which meant a
# fresh database silently had no roles or permissions at all -- and with
# users.role_id NOT NULL, no account could be created and nobody could log in.
#
# NOTE for a real deployment: auto-migrating on container start is right for
# this compose-based dev/demo setup, but not for production. There you want
# `alembic upgrade head` in a separate, gated release job so that multiple
# replicas cannot race each other and rollbacks stay deliberate. The
# reference-data sync below should move into that same release job -- it is
# tied to the deployed code version and must always travel with it. If this
# ever runs with more than one replica, wrap both steps in a Postgres
# advisory lock (SELECT pg_advisory_lock(...)) so only one performs them.
#
# `set -e` so a failed migration stops the container loudly instead of
# starting an app against a half-built schema.
set -e

echo "[entrypoint] Applying database migrations..."
alembic upgrade head

# Roles, permissions, role grants, locations, teams. Idempotent and
# reconciling -- see app/bootstrap.py. Demo user accounts are NOT created
# here; those are opt-in via `python -m app.seed`.
echo "[entrypoint] Syncing reference data..."
python -m app.bootstrap

echo "[entrypoint] Starting: $*"
# exec so the app replaces this shell as PID 1 and receives SIGTERM/SIGINT
# directly -- otherwise `docker compose stop` would wait out the timeout and
# kill the container instead of shutting the server down cleanly.
exec "$@"
