"""nest reimbursement under transfer

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-11
"""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    transfer_section = bind.execute(
        sa.text("SELECT id FROM categories WHERE kind = 'transfer' AND parent_id IS NULL")
    ).scalar()
    if transfer_section is None:
        bind.execute(
            sa.text(
                "INSERT INTO categories (name, parent_id, kind, sort_order) "
                "VALUES ('Transfer', NULL, 'transfer', 10000)"
            )
        )
        transfer_section = bind.execute(
            sa.text("SELECT id FROM categories WHERE kind = 'transfer' AND parent_id IS NULL")
        ).scalar()
    else:
        bind.execute(sa.text("UPDATE categories SET name = 'Transfer' WHERE id = :id"), {"id": transfer_section})

    reimb_section = bind.execute(
        sa.text("SELECT id FROM categories WHERE kind = 'reimbursement' AND parent_id IS NULL")
    ).scalar()
    if reimb_section is None:
        return
    reimb_leaf = bind.execute(
        sa.text("SELECT id FROM categories WHERE kind = 'reimbursement' AND parent_id = :pid"),
        {"pid": reimb_section},
    ).scalar()
    if reimb_leaf is None:
        # The old section has no child: promote it straight into a leaf under Transfer.
        bind.execute(
            sa.text(
                "UPDATE categories SET parent_id = :tid, name = 'Reimbursements', sort_order = 10001 WHERE id = :sid"
            ),
            {"tid": transfer_section, "sid": reimb_section},
        )
        return
    bind.execute(
        sa.text("UPDATE transactions SET category_id = :lid WHERE category_id = :sid"),
        {"lid": reimb_leaf, "sid": reimb_section},
    )
    bind.execute(
        sa.text(
            "UPDATE categories SET parent_id = :tid, name = 'Reimbursements', sort_order = 10001 WHERE id = :lid"
        ),
        {"tid": transfer_section, "lid": reimb_leaf},
    )
    bind.execute(sa.text("DELETE FROM categories WHERE id = :sid"), {"sid": reimb_section})


def downgrade() -> None:
    bind = op.get_bind()
    transfer_section = bind.execute(
        sa.text("SELECT id FROM categories WHERE kind = 'transfer' AND parent_id IS NULL")
    ).scalar()
    if transfer_section is None:
        return
    reimb_leaf = bind.execute(
        sa.text("SELECT id FROM categories WHERE kind = 'reimbursement' AND parent_id = :tid"),
        {"tid": transfer_section},
    ).scalar()
    if reimb_leaf is not None:
        bind.execute(
            sa.text(
                "INSERT INTO categories (name, parent_id, kind, sort_order) "
                "VALUES ('Reimbursements', NULL, 'reimbursement', 10001)"
            )
        )
        section_id = bind.execute(
            sa.text(
                "SELECT id FROM categories WHERE name = 'Reimbursements' "
                "AND parent_id IS NULL AND kind = 'reimbursement'"
            )
        ).scalar()
        bind.execute(
            sa.text("UPDATE categories SET parent_id = :sid, name = 'Reimbursable' WHERE id = :lid"),
            {"sid": section_id, "lid": reimb_leaf},
        )
    bind.execute(sa.text("UPDATE categories SET name = 'Transfers' WHERE id = :tid"), {"tid": transfer_section})
