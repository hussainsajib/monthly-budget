"""recurring loan link

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("recurring_templates") as batch:
        batch.add_column(sa.Column("loan_account_id", sa.Integer, nullable=True))
        batch.create_foreign_key(
            "fk_recurring_templates_loan_account_id_accounts",
            "accounts",
            ["loan_account_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_recurring_templates_loan_account_id", ["loan_account_id"])


def downgrade() -> None:
    with op.batch_alter_table("recurring_templates") as batch:
        batch.drop_index("ix_recurring_templates_loan_account_id")
        batch.drop_constraint("fk_recurring_templates_loan_account_id_accounts", type_="foreignkey")
        batch.drop_column("loan_account_id")
