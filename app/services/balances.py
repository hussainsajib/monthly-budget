"""Signed balance deltas, kept in one place so the accounts table, the loans page and cash flow agree.

An account's balance is never stored: it is ``opening_balance_cents`` plus the sum of its
transactions' signed deltas, counting only rows dated on or after ``opening_date``. The rule itself
lives in ``app.models.ledger.signed_delta``; this is its SQL form, and ``tests/test_integrity.py``
pins the two together and pins it to the Python walk in ``app.services.cashflow``.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.models import TRANSFER, Account, Category, Transaction
from app.services.category_config import income_keys


def delta_expression(income: set[str]):
    """SQL form of ``app.models.ledger.signed_delta``: one branch per decision that function makes."""
    return case(
        (Category.kind == TRANSFER, Transaction.amount_cents),
        (Category.kind.in_(income), Transaction.amount_cents),
        else_=-Transaction.amount_cents,
    )


def balance_deltas(db: Session, account_ids: set[int] | None = None, as_of: date | None = None) -> dict[int, int]:
    """Per-account balance change from transactions (up to ``as_of``, inclusive).

    Rows dated before the account's ``opening_date`` are excluded: the opening balance already
    accounts for them, so the same account reads the same here as in cash flow.
    """
    stmt = (
        select(Transaction.account_id, func.sum(delta_expression(income_keys(db))))
        .join(Category, Transaction.category_id == Category.id)
        .join(Account, Transaction.account_id == Account.id)
        .where(
            Transaction.account_id.is_not(None),
            or_(Account.opening_date.is_(None), Transaction.date >= Account.opening_date),
        )
        .group_by(Transaction.account_id)
    )
    if account_ids is not None:
        stmt = stmt.where(Transaction.account_id.in_(account_ids))
    if as_of is not None:
        stmt = stmt.where(Transaction.date <= as_of)
    return {acc_id: total or 0 for acc_id, total in db.execute(stmt).all()}
