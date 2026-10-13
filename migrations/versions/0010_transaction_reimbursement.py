"""transaction reimbursement link

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-11
"""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("transactions") as batch:
        batch.add_column(sa.Column("reimbursement_id", sa.String(36), nullable=True))
        batch.create_index("ix_transactions_reimbursement_id", ["reimbursement_id"])


def downgrade() -> None:
    with op.batch_alter_table("transactions") as batch:
        batch.drop_index("ix_transactions_reimbursement_id")
        batch.drop_column("reimbursement_id")