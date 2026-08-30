FROM python:3.13-slim

WORKDIR /app

# Install dependencies first (separate layer) so Docker's cache
# only invalidates this step when requirements.txt actually changes,
# not on every code edit.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# Invoked via `sh` rather than relying on the script's executable bit: compose
# bind-mounts ./backend over /app at runtime, so the file the container
# actually runs is the one on the host, where a chmod in this image would not
# apply (and where Windows checkouts do not carry an exec bit at all).
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]

# Passed to the entrypoint as "$@" -- it migrates, syncs reference data, then
# execs this.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
