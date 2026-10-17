"""plans and plan items

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-13
"""

import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "plans",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("status", sa.String(10), nullable=False, server_default="active"),
        sa.Column("config", sa.JSON(), nullable=True),
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_table(
        "plan_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("plan_id", sa.Integer(), sa.ForeignKey("plans.id", ondelete="CASCADE"), nullable=False),
        sa.Column("date", sa.Date(), nullable=True),
        sa.Column("description", sa.String(200), nullable=False, server_default=""),
        sa.Column("category_id", sa.Integer(), sa.ForeignKey("categories.id", ondelete="SET NULL"), nullable=True),
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("amount_cents", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("direction", sa.String(3), nullable=False, server_default="out"),
        sa.Column("item_kind", sa.String(20), nullable=False, server_default="custom"),
        sa.Column("source", sa.String(10), nullable=False, server_default="manual"),
        sa.Column("ref_id", sa.Integer(), nullable=True),
        sa.Column(
            "matched_transaction_id",
            sa.Integer(),
            sa.ForeignKey("transactions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_plan_items_plan_id", "plan_items", ["plan_id"])
    op.create_index("ix_plan_items_date", "plan_items", ["date"])
    op.create_index("ix_plan_items_plan_id_date", "plan_items", ["plan_id", "date"])


def downgrade() -> None:
    op.drop_index("ix_plan_items_plan_id_date", table_name="plan_items")
    op.drop_index("ix_plan_items_date", table_name="plan_items")
    op.drop_index("ix_plan_items_plan_id", table_name="plan_items")
    op.drop_table("plan_items")
    op.drop_table("plans")