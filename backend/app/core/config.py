from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Central place for all environment-driven configuration.
    pydantic-settings automatically reads matching env vars
    (case-insensitive) and validates their types.
    """

    PROJECT_NAME: str = "My Project API"
    DATABASE_URL: str = "postgresql://user:password@db:5432/appdb"
    CORS_ORIGINS: list[str] = ["http://localhost:3000"]

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
