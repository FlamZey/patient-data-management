"""add patient vitals and care fields

Revision ID: 48dfd3e9c4dc
Revises: e72234a57964
Create Date: 2026-08-26 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '48dfd3e9c4dc'
down_revision: Union[str, Sequence[str], None] = 'e72234a57964'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_NEW_COLUMNS = [
    "care_department_enc",
    "last_visit_date_enc",
    "systolic_bp_enc",
    "diastolic_bp_enc",
]


def upgrade() -> None:
    """Upgrade schema."""
    for column_name in _NEW_COLUMNS:
        op.add_column("patients", sa.Column(column_name, sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    for column_name in reversed(_NEW_COLUMNS):
        op.drop_column("patients", column_name)
