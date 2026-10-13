"""transaction recurring link

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-11
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("transactions") as batch:
        batch.add_column(sa.Column("recurring_template_id", sa.Integer, nullable=True))
        batch.create_foreign_key(
            "fk_transactions_recurring_template_id_recurring_templates",
            "recurring_templates",
            ["recurring_template_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_transactions_recurring_template_id", ["recurring_template_id"])


def downgrade() -> None:
    with op.batch_alter_table("transactions") as batch:
        batch.drop_index("ix_transactions_recurring_template_id")
        batch.drop_constraint("fk_transactions_recurring_template_id_recurring_templates", type_="foreignkey")
        batch.drop_column("recurring_template_id")