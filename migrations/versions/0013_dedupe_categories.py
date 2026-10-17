"""dedupe duplicate categories (same name + parent + kind)

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-13
"""

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

_REF_TABLES = ("transactions", "recurring_templates", "import_rules")


def _used(bind: sa.engine.Connection, category_id: int) -> int:
    """Total rows referencing a category across every FK table."""
    total = 0
    for table in _REF_TABLES:
        total += int(
            bind.execute(
                sa.text(f"SELECT count(*) FROM {table} WHERE category_id = :id"), {"id": category_id}
            ).scalar()
        )
    return total


def _merge(bind: sa.engine.Connection, rows: list[tuple]) -> None:
    """Rows are (id, name, parent_id, kind). Keep the most-referenced; move refs onto it; drop the rest."""
    rows.sort(key=lambda r: (-_used(bind, r[0]), r[0]))  # most-referenced first, then lowest id
    keeper, duplicates = rows[0], rows[1:]
    for dup in duplicates:
        for table in _REF_TABLES:
            bind.execute(
                sa.text(f"UPDATE {table} SET category_id = :keep WHERE category_id = :dup"),
                {"keep": keeper[0], "dup": dup[0]},
            )
        # A category's monthly-budget override is a 1:1 row keyed by category_id; the keeper's wins.
        bind.execute(sa.text("DELETE FROM monthly_budgets WHERE category_id = :dup"), {"dup": dup[0]})
        bind.execute(sa.text("DELETE FROM categories WHERE id = :id"), {"id": dup[0]})


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, name, parent_id, kind FROM categories ORDER BY id")
    ).fetchall()
    groups: dict[tuple, list[tuple]] = {}
    for r in rows:
        groups.setdefault((r[1].lower(), r[2], r[3]), []).append((r[0], r[1], r[2], r[3]))
    for group in groups.values():
        if len(group) > 1:
            _merge(bind, group)


def downgrade() -> None:
    pass