"""drop unused plan item ref_id

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("plan_items") as batch:
        batch.drop_column("ref_id")


def downgrade() -> None:
    with op.batch_alter_table("plan_items") as batch:
        batch.add_column(sa.Column("ref_id", sa.Integer(), nullable=True))
