"""widen import rule match_text to 256

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-12
"""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("import_rules") as batch:
        batch.alter_column(
            "match_text",
            existing_type=sa.String(120),
            type_=sa.String(256),
            existing_nullable=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("import_rules") as batch:
        batch.alter_column(
            "match_text",
            existing_type=sa.String(256),
            type_=sa.String(120),
            existing_nullable=False,
        )
