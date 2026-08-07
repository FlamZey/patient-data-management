from datetime import datetime
from pydantic import BaseModel, ConfigDict


class ItemBase(BaseModel):
    name: str
    description: str | None = None


class ItemCreate(ItemBase):
    """Shape of data accepted when creating an item (no id/timestamp yet)."""
    pass


class ItemRead(ItemBase):
    """Shape of data returned to clients -- includes DB-generated fields."""
    id: int
    created_at: datetime

    # Lets Pydantic build this schema directly from a SQLAlchemy
    # model instance (item.id, item.name, ...) instead of a dict.
    model_config = ConfigDict(from_attributes=True)
