from dotenv import find_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Walks up from this file to find the repo-root .env
ROOT_ENV_FILE = find_dotenv(usecwd=False)


class Settings(BaseSettings):
    """
    Central place for all environment-driven configuration.
    pydantic-settings automatically reads matching env vars
    (case-insensitive) and validates their types.
    """

    PROJECT_NAME: str = "Patient Records API"
    # Required, no default -- must be set in .env so the app never boots
    # against a placeholder credential. min_length=1 also rejects "".
    DATABASE_URL: str = Field(min_length=1)
    CORS_ORIGINS: list[str] = ["http://localhost:3000"]

    # JWT signing. No default -- generate with scripts/generate_secret_key.py.
    SECRET_KEY: str = Field(min_length=1)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # PHI encryption keys, versioned so old ciphertext stays readable after a
    # key rotation (see app.core.encryption). JSON object mapping version ->
    # base64 32-byte key, e.g. '{"1": "..."}'. Generate with
    # scripts/generate_encryption_key.py. No default: a placeholder key would
    # silently "work" while giving PHI no real protection.
    PATIENT_ENCRYPTION_KEYS: dict[int, str]
    PATIENT_ENCRYPTION_ACTIVE_VERSION: int = 1

    model_config = SettingsConfigDict(env_file=ROOT_ENV_FILE, extra="ignore")


settings = Settings()
