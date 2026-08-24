from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.core.config import settings
from app.core.limiter import limiter
from app.routers import auth, lookups, patients, users

# Descriptions shown as section headers in the /docs UI, one per router tag.
TAGS_METADATA = [
    {"name": "auth", "description": "Login, token refresh, logout, and the current-user endpoint."},
    {"name": "users", "description": "User account management -- list/get/create/update/suspend."},
    {
        "name": "patients",
        "description": "Patient record upload, listing, viewing, editing, and deletion. "
        "PHI fields are encrypted at rest and access is scoped per uploader.",
    },
    {"name": "lookups", "description": "Read-only reference data (roles, locations, teams)."},
]

app = FastAPI(
    title=settings.PROJECT_NAME,
    description="Role-based patient data management API.",
    version="1.0.0",
    openapi_tags=TAGS_METADATA,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(lookups.router)
app.include_router(patients.router)
app.include_router(users.router)


@app.get("/", include_in_schema=False)
def root():
    """Sends a bare visit to the API root to the interactive docs instead of a 404."""
    return RedirectResponse(url="/docs")


@app.get("/health", include_in_schema=False)
def health():
    """Simple liveness check."""
    return {"status": "ok"}