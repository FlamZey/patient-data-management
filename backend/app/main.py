from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, Response
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.core.config import settings
from app.core.limiter import limiter
from app.routers import audit, auth, lookups, patients, users

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
    {
        "name": "audit",
        "description": "Read-only access to the security/compliance audit log. "
        "Append-only: nothing here writes or deletes audit rows.",
    },
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


# Baseline browser-side defenses -- none of these stop an attack on their
# own, they each limit how bad a *different* bug becomes (a stray XSS, a
# hostile page framing this app, a plain-HTTP link).
@app.middleware("http")
async def add_security_headers(request: Request, call_next) -> Response:
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    return response

app.include_router(audit.router)
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