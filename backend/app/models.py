from sqlalchemy import Column, Integer, String, DateTime, func

from app.database import Base


class Item(Base):
    """
    Example table. Delete or rename once you have real domain
    models -- this exists so the CRUD example router and the
    first Alembic migration have something concrete to point at.
    """

    __tablename__ = "items"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    description = Column(String(1000), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())