from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from app.core.config import settings

# The engine manages the actual connection pool to Postgres.
engine = create_engine(settings.DATABASE_URL)

# Each request gets its own Session from this factory.
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# All ORM models inherit from this so Alembic/SQLAlchemy can
# discover their table definitions.
Base = declarative_base()


def get_db():
    """
    FastAPI dependency that yields a DB session and guarantees
    it's closed after the request finishes, even on error.
    Use it like: def endpoint(db: Session = Depends(get_db))
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
