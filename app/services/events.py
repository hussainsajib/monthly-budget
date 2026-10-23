"""The one stream of dated money movements: real transactions, recurring occurrences and plan items.

Anything that looks ahead - plans today, budgets and cash flow next - reads movements shaped the
same way here, so a future-dated transaction, a recurring occurrence and a manual plan adjustment
are interchangeable to the arithmetic. Dividends:

- one place defines what an event *is* (the keys below), instead of each caller inventing its own
  dict shape;
- the same recurring expansion feeds plans and anything else that needs it;
- adding a new source (say, scheduled loan payments) means one function and one entry in
  ``event_stream``'s ``sources``, not a new merge in every caller.

An event's ``amount_cents`` is the **signed effect on its account** - the same quantity every balance
is built from (``app.models.ledger``). ``direction`` rides along only as the display label. Producers
get the sign from the one rule in the model, never by hand, so the stream and the ledger cannot
disagree about which way money moved.
"""

from __future__ import annotations

from datetime import date
from typing import TypedDict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import REIMBURSEMENT, TRANSFER, Plan, RecurringTemplate, Transaction
from app.models.ledger import direction_of, signed_delta
from app.services.category_config import income_keys
from app.services.recurring import occurrences

MANUAL = "manual"
RECURRING = "recurring"
LEDGER = "ledger"

SOURCES = (MANUAL, RECURRING, LEDGER)


class Event(TypedDict, total=False):
    """A dated movement. Keys not always present (``balance_cents``, drift fields) are added later."""

    item_id: int | None
    date: date | None
    description: str
    category_id: int | None
    category_path: str
    account_id: int | None
    amount_cents: int  # signed effect on the account
    direction: str  # "in" | "out" - display label, always the sign of amount_cents
    item_kind: str
    source: str  # "manual" | "recurring" | "ledger"
    ref_id: int | None
    matched_transaction_id: int | None


def _occurrences_between(schedule: dict, start: date, end: date) -> list[date]:
    """Occurrences of a schedule in [start, end]; rides on ``recurring.occurrences`` month by month."""
    out: list[date] = []
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        for when in occurrences(schedule, cursor.year, cursor.month):
            if start <= when <= end:
                out.append(when)
        cursor = date(cursor.year + 1, 1, 1) if cursor.month == 12 else date(cursor.year, cursor.month + 1, 1)
    return out


def recurring_events(
    db: Session, start: date, end: date, *, income_only: bool | None = None, tree=None
) -> list[Event]:
    """Active recurring templates expanded across [start, end].

    ``income_only`` filters to income (``True``) or outgoings (``False``); ``None`` returns both.
    Transfers and reimbursements are skipped on the outgoing side - they only move money between the
    user's own pockets, so listing them as spending would double count it.
    """
    income = income_keys(db)
    events: list[Event] = []
    for tpl in db.scalars(select(RecurringTemplate).where(RecurringTemplate.is_active.is_(True))):
        kind = tpl.category.kind if tpl.category else "expense"
        is_income = kind in income
        if income_only is not None and income_only != is_income:
            continue
        if not is_income and kind in (TRANSFER, REIMBURSEMENT):
            continue
        schedule = (
            tpl.schedule
            if tpl.schedule is not None
            else {"freq": "monthly", "interval": 1, "start": "2000-01-01", "by_month_day": [tpl.day_of_month]}
        )
        for when in _occurrences_between(schedule, start, end):
            events.append(
                {
                    "item_id": None,
                    "date": when,
                    "description": tpl.description,
                    "category_id": tpl.category_id,
                    "category_path": tree.path(tpl.category_id) if tree else "",
                    "account_id": tpl.account_id,
                    "amount_cents": signed_delta(abs(tpl.amount_cents), kind=kind, is_income=is_income),
                    "direction": "in" if is_income else "out",
                    "item_kind": "income" if is_income else "commitment",
                    "source": RECURRING,
                    "ref_id": tpl.id,
                    "matched_transaction_id": None,
                }
            )
    return events


def manual_events(plan: Plan, tree) -> list[Event]:
    """The plan's hand-entered adjustments, as events."""
    events: list[Event] = []
    for item in plan.items:
        events.append(
            {
                "item_id": item.id,
                "date": item.date,
                "description": item.description or (item.category.name if item.category else "Adjustment"),
                "category_id": item.category_id,
                "category_path": tree.path(item.category_id) if item.category_id else "",
                "account_id": item.account_id,
                "amount_cents": item.amount_cents,
                "direction": direction_of(item.amount_cents),
                "item_kind": item.item_kind,
                "source": MANUAL,
                "ref_id": None,
                "matched_transaction_id": item.matched_transaction_id,
            }
        )
    return events


def ledger_events(
    db: Session,
    start: date,
    end: date,
    *,
    after: date | None = None,
    account_id: int | None = None,
    tree=None,
) -> list[Event]:
    """Real transactions dated in [start, end] as events, so they sit in the same stream.

    ``after`` drops rows on or before that date - callers pass a starting-balance date (today, say)
    so a row already counted in that balance is not counted again. ``account_id`` narrows to one
    account. A row is an event like any other: it carries its own ``matched_transaction_id``, which
    keeps the drift matcher from pairing it with a different transaction.
    """
    stmt = select(Transaction).where(Transaction.date >= start, Transaction.date <= end)
    if after is not None:
        stmt = stmt.where(Transaction.date > after)
    if account_id is not None:
        stmt = stmt.where(Transaction.account_id == account_id)
    stmt = stmt.order_by(Transaction.date, Transaction.id)

    income = income_keys(db)
    events: list[Event] = []
    for txn in db.scalars(stmt).unique():
        kind = txn.category.kind if txn.category else "expense"
        is_income = kind in income
        effect = txn.cash_delta_cents(is_income)
        events.append(
            {
                "item_id": None,
                "date": txn.date,
                "description": txn.description,
                "category_id": txn.category_id,
                "category_path": tree.path(txn.category_id) if tree and txn.category_id else "",
                "account_id": txn.account_id,
                "amount_cents": effect,
                "direction": direction_of(effect),
                "item_kind": "income" if is_income else "commitment",
                "source": LEDGER,
                "ref_id": None,
                "matched_transaction_id": txn.id,
            }
        )
    return events


def event_stream(
    db: Session,
    *,
    start: date,
    end: date,
    sources: tuple[str, ...] = SOURCES,
    plan: Plan | None = None,
    tree=None,
    income_only: bool | None = None,
    account_id: int | None = None,
    after: date | None = None,
) -> list[Event]:
    """Merge the requested sources into one list - the single entry point callers should use.

    Not sorted here: callers know the tie-breaks they want (plans put manual items last on a date).
    Manual items dated after ``end`` are dropped (undated items fall back to ``start``), so every
    source honours the requested window.
    """
    events: list[Event] = []
    if RECURRING in sources:
        events += recurring_events(db, start, end, income_only=income_only, tree=tree)
    if MANUAL in sources and plan is not None:
        events += [e for e in manual_events(plan, tree) if (e["date"] or start) <= end]
    if LEDGER in sources:
        events += ledger_events(db, start, end, after=after, account_id=account_id, tree=tree)
    return events


def to_public(event: dict) -> dict:
    """An event in the shape the API and UI expect: a positive ``amount_cents`` plus ``direction``.

    Internally ``amount_cents`` is signed; the wire keeps the magnitude+direction pair, so the
    boundary is the one place that flips between the two. ``actual_cents``, ``variance_cents`` and
    ``balance_cents`` are already signed and pass through unchanged.
    """
    out = dict(event)
    out["amount_cents"] = abs(event["amount_cents"])
    out["direction"] = event["direction"]
    return out
