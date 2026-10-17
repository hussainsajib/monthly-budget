"""loan_details, and fold the credit account kind into debt

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "loan_details",
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("loan_type", sa.String(20), nullable=False, server_default=""),
        sa.Column("lender", sa.String(80), nullable=False, server_default=""),
        sa.Column("original_principal_cents", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rate_bps", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_interest_bearing", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("min_payment_cents", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("due_day", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("credit_limit_cents", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reference", sa.Text(), nullable=False, server_default=""),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
    )
    # "credit" stops being an account type: cards are loans, so their accounts become kind='debt'.
    # Without this the old rows would carry a kind the type list no longer knows and could not be edited.
    op.execute("UPDATE accounts SET kind = 'debt' WHERE kind = 'credit'")


def downgrade() -> None:
    op.drop_table("loan_details")
