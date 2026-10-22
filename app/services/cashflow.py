"""Running-balance timeline: the one place an account's balance over time is worked out.

An account's balance is never stored: it is ``opening_balance_cents`` plus the sum of its
transactions' signed deltas. ``app.models.ledger.signed_delta`` is the rule, ``balances.py`` is
its SQL form, and this module is the Python timeline form - one walk, stopped at whatever date a
caller cares about (``balance_at``) or kept in full (``build_ledger``), for one account or many
(``running_deltas``). Cash flow, plans, loans and affordability all read the same walk, so they
cannot disagree about a balance at a date.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Account, Transaction
from app.services.category_config import income_keys
from app.services.reference import LOW_BALANCE_KEY, WARN_BALANCE_KEY, get_int_setting


@dataclass
class LedgerRow:
    txn: Transaction
    delta_cents: int
    balance_cents: int
    is_planned: bool
    level: str  # "", "warn" or "low"


@dataclass
class Ledger:
    rows: list[LedgerRow]
    current_balance_cents: int
    projected_balance_cents: int
    lowest: LedgerRow | None
    low_threshold_cents: int
    warn_threshold_cents: int


def _walk(db: Session, account: Account, today: date) -> tuple[list[LedgerRow], int, int]:
    """One account's rows in date order, each with its signed delta and running balance.

    Returns the rows plus two balances: the balance as of ``today`` (no planned rows) and the
    balance after every row including future-dated ones.
    """
    stmt = select(Transaction).where(Transaction.account_id == account.id)
    if account.opening_date:
        stmt = stmt.where(Transaction.date >= account.opening_date)
    stmt = stmt.order_by(Transaction.date, Transaction.id)

    balance = account.opening_balance_cents
    current = balance
    rows: list[LedgerRow] = []
    income = income_keys(db)
    for txn in db.scalars(stmt).unique():
        delta = txn.cash_delta_cents(txn.category.kind in income)
        balance += delta
        planned = txn.date > today
        if not planned:
            current = balance
        rows.append(LedgerRow(txn, delta, balance, planned, ""))
    return rows, current, balance


def build_ledger(db: Session, account: Account, today: date | None = None) -> Ledger:
    today = today or date.today()
    low = get_int_setting(db, LOW_BALANCE_KEY, 50_000)
    warn = get_int_setting(db, WARN_BALANCE_KEY, 100_000)
    rows, current, projected = _walk(db, account, today)
    for row in rows:
        row.level = "low" if row.balance_cents < low else "warn" if row.balance_cents < warn else ""
    return Ledger(
        rows=rows,
        current_balance_cents=current,
        projected_balance_cents=projected,
        lowest=min(rows, key=lambda r: r.balance_cents, default=None),
        low_threshold_cents=low,
        warn_threshold_cents=warn,
    )


def balance_at(db: Session, account: Account, when: date, today: date | None = None) -> int:
    """The account's balance on ``when``: the same walk cash flow shows, stopped at that date."""
    rows, _, _ = _walk(db, account, today or date.today())
    balance = account.opening_balance_cents
    for row in rows:
        if row.txn.date > when:
            break
        balance = row.balance_cents
    return balance


def running_deltas(db: Session, accounts: list[Account]) -> dict[int, list[tuple[date, int]]]:
    """Per-account ``(date, cumulative signed delta)`` timelines for many accounts in one query.

    The deltas start at zero, so a caller adds ``opening_balance_cents`` to get the balance - the
    same shape ``balances.balance_deltas`` returns in aggregate, and like it, rows dated before an
    account's ``opening_date`` are skipped. Reads bounded by a date stop at that date, so planned
    rows only enter a caller's numbers when its window reaches them.
    """
    opening_dates = {a.id: a.opening_date for a in accounts}
    timelines: dict[int, list[tuple[date, int]]] = {acc_id: [] for acc_id in opening_dates}
    if not timelines:
        return timelines

    income = income_keys(db)
    running = dict.fromkeys(timelines, 0)
    stmt = (
        select(Transaction)
        .where(Transaction.account_id.in_(timelines))
        .order_by(Transaction.date, Transaction.id)
    )
    for txn in db.scalars(stmt).unique():
        acc_id = txn.account_id
        if acc_id not in running:
            continue
        opened = opening_dates[acc_id]
        if opened and txn.date < opened:
            continue
        running[acc_id] += txn.cash_delta_cents(txn.category.kind in income)
        timelines[acc_id].append((txn.date, running[acc_id]))
    return timelines


def balance_on(timeline: list[tuple[date, int]], when: date) -> int:
    """The last cumulative value in ``timeline`` dated on or before ``when`` (0 when none)."""
    value = 0
    for when_date, cumulative in timeline:
        if when_date > when:
            break
        value = cumulative
    return value
