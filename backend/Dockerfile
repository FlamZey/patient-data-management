FROM python:3.13-slim

WORKDIR /app

# Separate layer so the cache only invalidates on a real requirements.txt change, not every code edit.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# Invoked via `sh`, not the script's exec bit: compose bind-mounts ./backend over /app, so the host's file runs, and Windows checkouts carry no exec bit anyway.
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]

# Passed to the entrypoint as "$@" -- it migrates and syncs reference data, then execs this.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
