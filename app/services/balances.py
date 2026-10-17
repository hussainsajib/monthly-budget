"""Signed balance deltas, kept in one place so the accounts table, the loans page and cash flow agree.

An account's balance is never stored: it is ``opening_balance_cents`` plus the sum of its
transactions' signed deltas. The rule itself lives in ``app.models.ledger.signed_delta``; this is
its SQL form, and ``tests/test_integrity.py`` pins the two together.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import TRANSFER, Category, Transaction
from app.services.category_config import income_keys


def delta_expression(income: set[str]):
    """SQL form of ``app.models.ledger.signed_delta``: one branch per decision that function makes."""
    return case(
        (Category.kind == TRANSFER, Transaction.amount_cents),
        (Category.kind.in_(income), Transaction.amount_cents),
        else_=-Transaction.amount_cents,
    )


def balance_deltas(db: Session, account_ids: set[int] | None = None, as_of: date | None = None) -> dict[int, int]:
    """Per-account balance change from transactions (up to ``as_of``, inclusive)."""
    stmt = (
        select(Transaction.account_id, func.sum(delta_expression(income_keys(db))))
        .join(Category, Transaction.category_id == Category.id)
        .where(Transaction.account_id.is_not(None))
        .group_by(Transaction.account_id)
    )
    if account_ids is not None:
        stmt = stmt.where(Transaction.account_id.in_(account_ids))
    if as_of is not None:
        stmt = stmt.where(Transaction.date <= as_of)
    return {acc_id: total or 0 for acc_id, total in db.execute(stmt).all()}
