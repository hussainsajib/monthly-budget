"""transaction transfer link

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-11
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("transactions") as batch:
        batch.add_column(sa.Column("transfer_id", sa.String(36), nullable=True))
        batch.create_index("ix_transactions_transfer_id", ["transfer_id"])


def downgrade() -> None:
    with op.batch_alter_table("transactions") as batch:
        batch.drop_index("ix_transactions_transfer_id")
        batch.drop_column("transfer_id")
