"""import rules

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "import_rules",
        sa.Column("id", sa.Integer, nullable=False),
        sa.Column("match_text", sa.String(120), nullable=False),
        sa.Column("account_id", sa.Integer, nullable=False),
        sa.Column("date_from", sa.Date),
        sa.Column("date_to", sa.Date),
        sa.Column("category_id", sa.Integer, nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id", name="pk_import_rules"),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name="fk_import_rules_account_id_accounts",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name="fk_import_rules_category_id_categories",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_import_rules_account_id", "import_rules", ["account_id"])


def downgrade() -> None:
    op.drop_index("ix_import_rules_account_id", table_name="import_rules")
    op.drop_table("import_rules")