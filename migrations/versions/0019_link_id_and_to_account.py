"""unify pairing link and rename recurring loan target

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # One pairing column for both transfers and reimbursements: the shared id plus which kind it is.
    with op.batch_alter_table("transactions") as batch:
        batch.add_column(sa.Column("link_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("link_kind", sa.String(20), nullable=True))
        batch.create_index("ix_transactions_link_id", ["link_id"])
        batch.create_index("ix_transactions_link_kind", ["link_kind"])
    op.execute("UPDATE transactions SET link_id = transfer_id, link_kind = 'transfer' WHERE transfer_id IS NOT NULL")
    op.execute(
        "UPDATE transactions SET link_id = reimbursement_id, link_kind = 'reimbursement'"
        " WHERE transfer_id IS NULL AND reimbursement_id IS NOT NULL"
    )
    with op.batch_alter_table("transactions") as batch:
        batch.drop_index("ix_transactions_transfer_id")
        batch.drop_index("ix_transactions_reimbursement_id")
        batch.drop_column("transfer_id")
        batch.drop_column("reimbursement_id")

    # The recurring field is not loan-specific: it is the account money flows into.
    with op.batch_alter_table("recurring_templates") as batch:
        batch.alter_column("loan_account_id", new_column_name="to_account_id")


def downgrade() -> None:
    with op.batch_alter_table("recurring_templates") as batch:
        batch.alter_column("to_account_id", new_column_name="loan_account_id")

    with op.batch_alter_table("transactions") as batch:
        batch.add_column(sa.Column("transfer_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("reimbursement_id", sa.String(36), nullable=True))
        batch.create_index("ix_transactions_transfer_id", ["transfer_id"])
        batch.create_index("ix_transactions_reimbursement_id", ["reimbursement_id"])
    op.execute("UPDATE transactions SET transfer_id = link_id WHERE link_kind = 'transfer'")
    op.execute(
        "UPDATE transactions SET reimbursement_id = link_id WHERE link_kind = 'reimbursement'"
    )
    with op.batch_alter_table("transactions") as batch:
        batch.drop_index("ix_transactions_link_id")
        batch.drop_index("ix_transactions_link_kind")
        batch.drop_column("link_id")
        batch.drop_column("link_kind")
