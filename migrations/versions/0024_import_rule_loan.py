"""import rule loan payment action

Revision ID: 0024
Revises: 0023
Create Date: 2026-10-31
"""

import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("import_rules") as batch:
        batch.add_column(sa.Column("loan_account_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_import_rules_loan_account", "accounts", ["loan_account_id"], ["id"], ondelete="CASCADE"
        )


def downgrade() -> None:
    with op.batch_alter_table("import_rules") as batch:
        batch.drop_constraint("fk_import_rules_loan_account", type_="foreignkey")
        batch.drop_column("loan_account_id")
