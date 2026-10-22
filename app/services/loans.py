"""Loans.

A loan *is* an account with ``kind == "debt"``; a 1:1 ``LoanDetails`` row carries the loan-facing
facts. Nothing about the balance lives here - it stays ``opening + signed transaction deltas``, the
same as every other account, so a loan can never drift from its ledger.

Signs are the one thing worth stating plainly: internally a debt account keeps the ledger's signed
convention, so owing $2,000 reads as ``-200000``. Everything a person looks at wants the opposite,
so this module exposes ``owed_cents`` (positive = you owe) for loan surfaces.
"""

from __future__ import annotations

import calendar
import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import TRANSFER, Account, LoanDetails, RecurringTemplate, Transaction
from app.models.ledger import signed_delta
from app.services import transfers as transfer_service
from app.services.balances import balance_deltas
from app.services.cashflow import balance_on, build_ledger, running_deltas
from app.services.category_config import income_keys
from app.services.loan_config import get_loan_types
from app.services.recurring import occurrences
from app.services.reference import list_accounts

LOAN_KIND = "debt"

LOAN_SORTS = ("name", "type", "lender", "owed", "balance", "rate", "payoff", "payment", "due", "status")


class LoanError(ValueError):
    """A loan request was invalid (shown to the user)."""


@dataclass
class LoanStats:
    transaction_count: int = 0
    last_activity: date | None = None


def is_loan(account: Account) -> bool:
    return account.kind == LOAN_KIND


def owed_cents(account: Account, balance_cents: int) -> int:
    """What you owe, positive; the inverse of the signed ledger balance for a loan."""
    return -balance_cents


def ensure_details(db: Session, account: Account) -> LoanDetails:
    """Give a debt account its loan metadata row if it does not have one yet."""
    if account.loan is None:
        account.loan = LoanDetails(account_id=account.id)
        db.add(account.loan)
        db.flush()
    return account.loan


def drop_details(db: Session, account: Account) -> None:
    """Remove loan metadata when an account stops being a loan."""
    if account.loan is not None:
        db.delete(account.loan)
        account.loan = None
        db.flush()


def _next_due(due_day: int, today: date | None = None) -> date | None:
    if not 1 <= due_day <= 31:
        return None
    today = today or date.today()
    for year, month in ((today.year, today.month), _next_month(today)):
        day = min(due_day, calendar.monthrange(year, month)[1])
        candidate = date(year, month, day)
        if candidate >= today:
            return candidate
    return None


def _next_month(d: date) -> tuple[int, int]:
    return (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)


def _schedule_of(tpl: RecurringTemplate) -> dict:
    return tpl.schedule if tpl.schedule is not None else {
        "freq": "monthly",
        "interval": 1,
        "start": "2000-01-01",
        "by_month_day": [tpl.day_of_month],
    }


def _next_occurrence(schedule: dict, today: date) -> date | None:
    year, month = today.year, today.month
    for _ in range(13):
        for when in occurrences(schedule, year, month):
            if when >= today:
                return when
        year, month = _next_month(date(year, month, 1))
    return None


def scheduled_payments(
    db: Session, account_ids: set[int], today: date | None = None
) -> dict[int, dict]:
    """The nearest upcoming payment commitment per loan, from recurring items linked to it."""
    if not account_ids:
        return {}
    today = today or date.today()
    templates = db.scalars(
        select(RecurringTemplate).where(
            RecurringTemplate.to_account_id.in_(account_ids),
            RecurringTemplate.is_active.is_(True),
        )
    ).unique()
    best: dict[int, dict] = {}
    for tpl in templates:
        when = _next_occurrence(_schedule_of(tpl), today)
        if when is None or tpl.to_account_id is None:
            continue
        current = best.get(tpl.to_account_id)
        if current is not None and date.fromisoformat(current["date"]) <= when:
            continue
        best[tpl.to_account_id] = {
            "recurring_template_id": tpl.id,
            "description": tpl.description,
            "amount_cents": abs(tpl.amount_cents),
            "date": when.isoformat(),
            "from_account_id": tpl.account_id,
            "from_account_name": tpl.account.name if tpl.account else None,
        }
    return best


def _type_labels(db: Session) -> dict[str, str]:
    return {t.key: t.label for t in get_loan_types(db)}


def loan_out(
    account: Account,
    balance_cents: int,
    labels: dict[str, str],
    stats: LoanStats | None = None,
    schedule: dict | None = None,
) -> dict:
    stats = stats or LoanStats()
    details = account.loan
    owed = owed_cents(account, balance_cents)
    original = details.original_principal_cents if details else 0
    residual = details.residual_cents if details else 0
    basis = original if original > 0 else abs(account.opening_balance_cents)
    paid = max(0, basis - owed) if basis > 0 else 0
    loan_type = details.loan_type if details else ""
    limit = details.credit_limit_cents if details else 0
    due_day = details.due_day if details else 0
    next_due = _next_due(due_day) if details else None
    return {
        "account_id": account.id,
        "name": account.name,
        "kind": account.kind,
        "is_active": account.is_active,
        "opening_balance_cents": account.opening_balance_cents,
        "opening_date": account.opening_date.isoformat() if account.opening_date else None,
        "balance_cents": balance_cents,
        "owed_cents": owed,
        "has_details": details is not None,
        "loan_type": loan_type,
        "loan_type_label": labels.get(loan_type, loan_type or "—"),
        "lender": details.lender if details else "",
        "original_principal_cents": original,
        "residual_cents": residual,
        "amortizing_owed_cents": max(0, owed - residual),
        "principal_basis_cents": basis,
        "principal_paid_cents": paid,
        "payoff_pct": round(min(100.0, paid / basis * 100), 1) if basis > 0 else 0.0,
        "rate_bps": details.rate_bps if details else 0,
        "rate_pct": round((details.rate_bps if details else 0) / 100, 2),
        "is_interest_bearing": details.is_interest_bearing if details else False,
        "min_payment_cents": details.min_payment_cents if details else 0,
        "due_day": due_day,
        "next_due_date": next_due.isoformat() if next_due else None,
        "credit_limit_cents": limit,
        "utilization_pct": round(owed / limit * 100, 1) if limit > 0 else None,
        "reference": details.reference if details else "",
        "notes": details.notes if details else "",
        "transaction_count": stats.transaction_count,
        "last_activity": stats.last_activity.isoformat() if stats.last_activity else None,
        "schedule": schedule,
    }


def _stats_for(db: Session, account_ids: set[int]) -> dict[int, LoanStats]:
    if not account_ids:
        return {}
    rows = db.execute(
        select(Transaction.account_id, func.count(), func.max(Transaction.date))
        .where(Transaction.account_id.in_(account_ids))
        .group_by(Transaction.account_id)
    ).all()
    return {acc_id: LoanStats(count, last) for acc_id, count, last in rows}


def loan_summaries(db: Session, include_inactive: bool = True) -> list[dict]:
    """Every debt account shaped for the loans table, unsorted."""
    accounts = [a for a in list_accounts(db, include_inactive=include_inactive) if is_loan(a)]
    todays = date.today()
    deltas = balance_deltas(db, {a.id for a in accounts}, as_of=todays)
    stats = _stats_for(db, {a.id for a in accounts})
    schedules = scheduled_payments(db, {a.id for a in accounts}, today=todays)
    labels = _type_labels(db)
    return [
        loan_out(
            a,
            a.opening_balance_cents + deltas.get(a.id, 0),
            labels,
            stats.get(a.id),
            schedules.get(a.id),
        )
        for a in accounts
    ]


def sort_loans(rows: list[dict], sort: str, desc: bool) -> list[dict]:
    keys = {
        "name": lambda r: r["name"].lower(),
        "type": lambda r: r["loan_type_label"].lower(),
        "lender": lambda r: r["lender"].lower(),
        "owed": lambda r: r["owed_cents"],
        "balance": lambda r: r["balance_cents"],
        "rate": lambda r: r["rate_bps"],
        "payoff": lambda r: r["payoff_pct"],
        "payment": lambda r: r["min_payment_cents"],
        "due": lambda r: r["due_day"],
        "status": lambda r: r["is_active"],
    }
    if sort not in LOAN_SORTS:
        raise LoanError(f"Sort must be one of: {', '.join(LOAN_SORTS)}")
    return sorted(rows, key=keys[sort], reverse=desc)


def totals(rows: list[dict]) -> dict:
    owed = sum(r["owed_cents"] for r in rows)
    by_type: dict[str, dict] = {}
    for r in rows:
        entry = by_type.setdefault(
            r["loan_type"] or "",
            {"key": r["loan_type"], "label": r["loan_type_label"], "owed_cents": 0, "count": 0},
        )
        entry["owed_cents"] += r["owed_cents"]
        entry["count"] += 1
    return {
        "owed_cents": owed,
        "count": len(rows),
        "original_cents": sum(r["original_principal_cents"] for r in rows),
        "residual_cents": sum(r["residual_cents"] for r in rows),
        "principal_paid_cents": sum(r["principal_paid_cents"] for r in rows),
        "balance_cents": sum(r["balance_cents"] for r in rows),
        "by_type": sorted(by_type.values(), key=lambda e: (-e["owed_cents"], e["label"])),
    }


def missing_details(db: Session) -> list[dict]:
    """Debt accounts with no loan metadata yet, for the one-time 'these are now loans' prompt."""
    accounts = [a for a in list_accounts(db, include_inactive=True) if is_loan(a) and a.loan is None]
    return [{"account_id": a.id, "name": a.name} for a in accounts]


def _month_ends(months: int, today: date | None = None) -> list[date]:
    today = today or date.today()
    ends: list[date] = []
    year, month = today.year, today.month
    for _ in range(max(1, months)):
        ends.append(date(year, month, calendar.monthrange(year, month)[1]))
        year, month = (year - 1, 12) if month == 1 else (year, month - 1)
    return list(reversed(ends))


def debt_trend(db: Session, months: int = 12) -> list[dict]:
    """Total owed at each of the last ``months`` month-ends, oldest first."""
    ends = _month_ends(months)
    accounts = [a for a in list_accounts(db, include_inactive=True) if is_loan(a)]
    if not accounts:
        return [{"month": end.strftime("%Y-%m"), "owed_cents": 0} for end in ends]

    timelines = running_deltas(db, accounts)
    out: list[dict] = []
    for end in ends:
        signed = 0
        for account in accounts:
            if account.opening_date and account.opening_date > end:
                continue
            signed += account.opening_balance_cents + balance_on(timelines[account.id], end)
        out.append({"month": end.strftime("%Y-%m"), "owed_cents": -signed})
    return out


def history(db: Session, account: Account) -> list[dict]:
    """Running balance for one loan, oldest first, with the owed sign applied."""
    ledger = build_ledger(db, account)
    return [
        {
            "txn_id": row.txn.id,
            "date": row.txn.date.isoformat(),
            "description": row.txn.description,
            "delta_cents": row.delta_cents,
            "owed_delta_cents": -row.delta_cents,
            "owed_cents": -row.balance_cents,
            "is_planned": row.is_planned,
        }
        for row in ledger.rows
    ]


def apply_details(details: LoanDetails, fields: dict) -> None:
    for key, value in fields.items():
        setattr(details, key, value)


def create_loan(
    db: Session,
    *,
    name: str,
    owed_cents_value: int,
    details_fields: dict,
    opening_date: date | None = None,
    is_active: bool = True,
    disbursement: dict | None = None,
) -> Account:
    """Create a debt account. ``owed_cents_value`` is the starting amount owed (positive).

    A disbursement means the borrowed money landed in an account you track, so it is booked as a
    transfer out of the loan into that account; the loan's opening balance is reduced by exactly
    that amount so the net owed still equals what was entered.
    """
    name = (name or "").strip()
    if not name:
        raise LoanError("A loan needs a name")
    if db.scalar(select(Account).where(func.lower(Account.name) == name.lower())) is not None:
        raise LoanError(f"'{name}' already exists")

    disbursed = int((disbursement or {}).get("amount_cents", 0))
    if disbursed < 0:
        raise LoanError("A disbursement cannot be negative")
    if disbursed == 0:
        disbursement = None

    account = Account(
        name=name,
        kind=LOAN_KIND,
        opening_balance_cents=-owed_cents_value + disbursed,
        opening_date=opening_date,
        is_active=is_active,
    )
    db.add(account)
    db.flush()

    details = LoanDetails(account_id=account.id)
    apply_details(details, details_fields)
    db.add(details)
    account.loan = details
    db.commit()

    if disbursement is not None:
        on_date = disbursement.get("date") or opening_date or date.today()
        if account.opening_date is None:
            account.opening_date = on_date
            db.commit()
        transfer_service.create_transfer(
            db,
            on_date=on_date,
            description=disbursement.get("description") or f"{name} proceeds",
            amount_cents=disbursed,
            from_account_id=account.id,
            to_account_id=disbursement["to_account_id"],
            notes=None,
        )
    return account


def record_payment(
    db: Session,
    loan: Account,
    *,
    from_account_id: int | None,
    amount_cents: int,
    on_date: date,
    description: str = "",
    notes: str | None = None,
) -> str:
    """Move money from a paying account into the loan: one transfer, both legs written."""
    if not is_loan(loan):
        raise LoanError("That account is not a loan")
    if from_account_id is None:
        raise LoanError("Choose the account the payment comes from")
    if from_account_id == loan.id:
        raise LoanError("A payment cannot come from the loan itself")
    return transfer_service.create_transfer(
        db,
        on_date=on_date,
        description=(description or "").strip() or f"Payment — {loan.name}",
        amount_cents=amount_cents,
        from_account_id=from_account_id,
        to_account_id=loan.id,
        notes=notes,
    )


def convert_to_payment(db: Session, loan: Account, txn: Transaction) -> str:
    """Turn an already-recorded money-out row into a payment on ``loan``.

    The row keeps its date, description, import hash and recurring link, but becomes the outgoing
    leg of a transfer; the matching incoming leg is written onto the loan. Use it when a lease or
    loan payment arrived as an ordinary expense from a bank import.
    """
    if not is_loan(loan):
        raise LoanError("That account is not a loan")
    if txn.link_id is not None:
        raise LoanError("That row is already linked to a transfer or a reimbursement")
    if txn.account_id is None:
        raise LoanError("That row has no account")
    if txn.account_id == loan.id:
        raise LoanError("That row is already on the loan")
    is_income = txn.category.kind in income_keys(db)
    delta = signed_delta(txn.amount_cents, kind=txn.category.kind, is_income=is_income)
    if delta >= 0:
        raise LoanError("Only a money-out row can become a loan payment")
    amount = abs(txn.amount_cents)
    category = transfer_service.ensure_transfer_category(db)
    link_id = str(uuid.uuid4())
    txn.category_id = category.id
    txn.amount_cents = -amount
    txn.link_id = link_id
    txn.link_kind = TRANSFER
    db.add(
        Transaction(
            date=txn.date,
            description=txn.description,
            category_id=category.id,
            account_id=loan.id,
            amount_cents=amount,
            notes=txn.notes,
            link_id=link_id,
            link_kind=TRANSFER,
        )
    )
    db.commit()
    return link_id
