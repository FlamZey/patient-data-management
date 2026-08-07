from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.routers import items

app = FastAPI(title=settings.PROJECT_NAME)

# Allows the Next.js frontend (running on a different origin/port)
# to call this API from the browser.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(items.router)


@app.get("/health")
def health():
    """Simple liveness check -- useful for Docker healthchecks and uptime monitors."""
    return {"status": "ok"}