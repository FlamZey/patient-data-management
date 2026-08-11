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

    model_config = SettingsConfigDict(env_file=ROOT_ENV_FILE, extra="ignore")


settings = Settings()
