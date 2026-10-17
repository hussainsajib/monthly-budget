"""loan residual/balloon

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("loan_details") as batch:
        batch.add_column(sa.Column("residual_cents", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    with op.batch_alter_table("loan_details") as batch:
        batch.drop_column("residual_cents")
