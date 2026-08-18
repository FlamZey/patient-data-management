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
    DATABASE_URL: str = "postgresql://user:password@db:5432/appdb"
    CORS_ORIGINS: list[str] = ["http://localhost:3000"]

    # JWT / auth. SECRET_KEY must be overridden via .env in any real deployment.
    SECRET_KEY: str = "dev-secret-key-change-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # Field-level PHI encryption. Keys are versioned so old ciphertext stays
    # readable after rotation -- see app.core.encryption. Provided as a JSON
    # object mapping version -> base64 32-byte key, e.g. '{"1": "..."}'.
    # Generate keys with backend/scripts/generate_encryption_key.py.
    PATIENT_ENCRYPTION_KEYS: dict[int, str] = {1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}
    PATIENT_ENCRYPTION_ACTIVE_VERSION: int = 1

    model_config = SettingsConfigDict(env_file=ROOT_ENV_FILE, extra="ignore")


settings = Settings()
