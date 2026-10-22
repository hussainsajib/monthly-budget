"""drop plan item recurring link

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-18
"""

import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("plan_items") as batch:
        batch.drop_index("ix_plan_items_recurring_template_id")
        batch.drop_constraint(
            "fk_plan_items_recurring_template_id_recurring_templates", type_="foreignkey"
        )
        batch.drop_column("recurring_template_id")


def downgrade() -> None:
    with op.batch_alter_table("plan_items") as batch:
        batch.add_column(sa.Column("recurring_template_id", sa.Integer, nullable=True))
        batch.create_foreign_key(
            "fk_plan_items_recurring_template_id_recurring_templates",
            "recurring_templates",
            ["recurring_template_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_plan_items_recurring_template_id", ["recurring_template_id"])
