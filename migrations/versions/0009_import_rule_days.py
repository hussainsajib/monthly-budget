"""import rule date window becomes an inclusive day-of-month window

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-11
"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("import_rules") as batch:
        batch.add_column(sa.Column("day_from", sa.Integer))
        batch.add_column(sa.Column("day_to", sa.Integer))
        batch.drop_column("date_from")
        batch.drop_column("date_to")


def downgrade() -> None:
    with op.batch_alter_table("import_rules") as batch:
        batch.add_column(sa.Column("date_from", sa.Date))
        batch.add_column(sa.Column("date_to", sa.Date))
        batch.drop_column("day_from")
        batch.drop_column("day_to")