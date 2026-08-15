FROM python:3.13-slim

WORKDIR /app

# Install dependencies first (separate layer) so Docker's cache
# only invalidates this step when requirements.txt actually changes,
# not on every code edit.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
