"""plan item signed amount

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Storage flips from "positive magnitude + direction" to the signed effect the event stream
    # already uses, so the one sign rule in app.models.ledger covers plan items too.
    op.execute("UPDATE plan_items SET amount_cents = -amount_cents WHERE direction = 'out'")
    with op.batch_alter_table("plan_items") as batch:
        batch.drop_column("direction")


def downgrade() -> None:
    with op.batch_alter_table("plan_items") as batch:
        batch.add_column(sa.Column("direction", sa.String(3), nullable=False, server_default="out"))
    op.execute("UPDATE plan_items SET direction = CASE WHEN amount_cents < 0 THEN 'out' ELSE 'in' END")
    op.execute("UPDATE plan_items SET amount_cents = abs(amount_cents)")
