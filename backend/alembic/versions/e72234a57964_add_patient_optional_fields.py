"""add patient optional fields

Revision ID: e72234a57964
Revises: 0c25d3c59dc1
Create Date: 2026-08-25 07:32:33.292221

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e72234a57964'
down_revision: Union[str, Sequence[str], None] = '0c25d3c59dc1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_OPTIONAL_FIELD_COLUMNS = [
    "street_address_enc",
    "city_enc",
    "state_enc",
    "zip_code_enc",
    "phone_enc",
    "email_enc",
    "emergency_contact_name_enc",
    "emergency_contact_relationship_enc",
    "emergency_contact_phone_enc",
    "preferred_language_enc",
    "race_ethnicity_enc",
    "marital_status_enc",
    "occupation_enc",
    "insurance_provider_enc",
    "policy_number_enc",
    "pcp_name_enc",
    "registration_date_enc",
    "preferred_pharmacy_enc",
    "blood_type_enc",
    "height_in_enc",
    "weight_lbs_enc",
    "allergies_enc",
    "current_medications_enc",
    "chronic_conditions_enc",
    "immunization_history_enc",
    "smoking_status_enc",
    "alcohol_use_enc",
]


def upgrade() -> None:
    """Upgrade schema."""
    for column_name in _OPTIONAL_FIELD_COLUMNS:
        op.add_column("patients", sa.Column(column_name, sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    for column_name in reversed(_OPTIONAL_FIELD_COLUMNS):
        op.drop_column("patients", column_name)
