from dotenv import find_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# Walks up from this file to find the repo-root .env
ROOT_ENV_FILE = find_dotenv(usecwd=False)


class Settings(BaseSettings):
    """
    Central place for all environment-driven configuration.
    pydantic-settings automatically reads matching env vars
    (case-insensitive) and validates their types.
    """

    PROJECT_NAME: str = "My Project API"
    # No default: must be set via .env in every environment (including local
    # dev) so the app never silently boots against a placeholder credential.
    DATABASE_URL: str
    CORS_ORIGINS: list[str] = ["http://localhost:3000"]

    # JWT / auth. No default -- must be overridden via .env in every environment.
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # Field-level PHI encryption. Keys are versioned so old ciphertext stays
    # readable after rotation -- see app.core.encryption. Provided as a JSON
    # object mapping version -> base64 32-byte key, e.g. '{"1": "..."}'.
    # Generate keys with backend/scripts/generate_encryption_key.py.
    # No default -- a placeholder key here would silently "work" while
    # providing no real confidentiality for PHI.
    PATIENT_ENCRYPTION_KEYS: dict[int, str]
    PATIENT_ENCRYPTION_ACTIVE_VERSION: int = 1

    model_config = SettingsConfigDict(env_file=ROOT_ENV_FILE, extra="ignore")


settings = Settings()
