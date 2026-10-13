"""import rule amount

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-11
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("import_rules", sa.Column("amount_cents", sa.Integer, nullable=True))


def downgrade() -> None:
    op.drop_column("import_rules", "amount_cents")
