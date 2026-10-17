"""JSON API for the React front end. Thin handlers over ``app.services``; money is integer cents."""

from __future__ import annotations

import datetime
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.money import to_cents
from app.db.session import get_db
from app.models import REIMBURSEMENT, TRANSFER, Account, Category, ImportRule, RecurringTemplate, Transaction
from app.schemas.transaction import TransactionInput
from app.services import budgets, import_rules, importing, integrity, reports
from app.services import categories as category_service
from app.services import loans as loan_service
from app.services import plans as plan_service
from app.services import reimbursements as reimbursement_service
from app.services import transactions as txn_service
from app.services import transfers as transfer_service
from app.services.account_config import account_type_keys, ensure_account_config, get_account_types
from app.services.balances import balance_deltas, delta_expression
from app.services.cashflow import build_ledger
from app.services.categories import CategoryTree
from app.services.category_config import (
    ensure_category_config,
    get_levels,
    get_types,
    income_keys,
    set_levels,
)
from app.services.loan_config import (
    LoanType,
    ensure_loan_config,
    get_loan_types,
    loan_type_keys,
    set_loan_types,
)
from app.services.plan_types import type_payloads
from app.services.recurring import list_templates, validate_schedule
from app.services.reference import (
    LOW_BALANCE_KEY,
    WARN_BALANCE_KEY,
    list_accounts,
    set_int_setting,
)

router = APIRouter(prefix="/api")

PAGE_SIZE = 100
ACCOUNT_SORTS = (
    "name",
    "kind",
    "opening",
    "opening_date",
    "balance",
    "transactions",
    "activity",
    "status",
)


def friendly(exc: Exception) -> str:
    """Short user-facing text for validation / parsing errors."""
    if isinstance(exc, ValidationError):
        return exc.errors()[0]["msg"].removeprefix("Value error, ")
    return str(exc)


@contextmanager
def user_errors() -> Iterator[None]:
    """Turn business-rule / parsing failures (all ValueErrors) into a 400 with a readable message."""
    try:
        yield
    except ValueError as exc:
        raise HTTPException(400, friendly(exc)) from exc


# ---------------------------------------------------------------- categories


class CategoryBody(BaseModel):
    name: str
    parent_id: int | None = None
    kind: str = "expense"
    budget: str = "0"
    description: str = ""
    sort_order: int = 0
    is_active: bool = True


def _category_rows(db: Session, tree: CategoryTree, include_system: bool = False) -> list[dict]:
    counts = dict(db.execute(select(Transaction.category_id, func.count()).group_by(Transaction.category_id)).all())
    recurring = dict(
        db.execute(select(RecurringTemplate.category_id, func.count()).group_by(RecurringTemplate.category_id)).all()
    )
    return [
        {
            "id": n.id,
            "name": n.name,
            "parent_id": n.category.parent_id,
            "kind": n.category.kind,
            "depth": n.depth,
            "path": n.path,
            "budget_cents": n.category.monthly_budget_cents,
            "effective_budget_cents": n.effective_budget_cents,
            "description": n.category.description,
            "sort_order": n.category.sort_order,
            "is_active": n.category.is_active,
            "has_children": bool(n.children),
            "child_count": len(n.children),
            "transaction_count": counts.get(n.id, 0),
            "recurring_count": recurring.get(n.id, 0),
        }
        for n in tree.walk()
        # system categories are managed, not shown generally
        if include_system or n.category.kind not in (TRANSFER, REIMBURSEMENT)
    ]


@router.get("/categories")
def list_categories(db: Session = Depends(get_db), include_system: bool = False):
    if include_system:
        # Make sure the transfer and reimbursement categories exist so import can offer them.
        transfer_service.ensure_transfer_category(db)
        reimbursement_service.ensure_reimbursement_category(db)
    return _category_rows(db, category_service.load_tree(db), include_system)


@router.post("/categories", status_code=201)
def create_category(body: CategoryBody, db: Session = Depends(get_db)):
    with user_errors():
        cat = category_service.create_category(
            db, body.name, body.parent_id, body.kind, to_cents(body.budget or "0"), body.description
        )
    return {"id": cat.id}


@router.put("/categories/{category_id}")
def update_category(category_id: int, body: CategoryBody, db: Session = Depends(get_db)):
    with user_errors():
        category_service.update_category(
            db,
            category_id,
            name=body.name,
            parent_id=body.parent_id,
            kind=body.kind,
            budget_cents=to_cents(body.budget or "0"),
            description=body.description,
            sort_order=body.sort_order,
            is_active=body.is_active,
        )
    return {"id": category_id}


@router.delete("/categories/{category_id}", status_code=204)
def delete_category(category_id: int, move_to_id: int | None = None, db: Session = Depends(get_db)):
    with user_errors():
        category_service.delete_category(db, category_id, move_to_id)
    return Response(status_code=204)


# ------------------------------------------------------------------ accounts


class AccountBody(BaseModel):
    name: str
    kind: str = "bank"
    opening_balance: str = "0"
    opening_date: date | None = None
    is_active: bool = True


def _account_out(a: Account, stats: dict | None = None) -> dict:
    stats = stats or {}
    balance = a.opening_balance_cents + stats.get("delta", 0)
    return {
        "id": a.id,
        "name": a.name,
        "kind": a.kind,
        "opening_balance_cents": a.opening_balance_cents,
        "opening_date": a.opening_date.isoformat() if a.opening_date else None,
        "current_balance_cents": balance,
        # A loan keeps the signed ledger balance but is read as "amount owed", which is its inverse.
        "is_loan": loan_service.is_loan(a),
        "owed_cents": loan_service.owed_cents(a, balance) if loan_service.is_loan(a) else balance,
        "loan_type": a.loan.loan_type if a.loan else None,
        "transaction_count": stats.get("count", 0),
        "transacted_cents": stats.get("abs", 0),
        "is_active": a.is_active,
    }


def _sort_accounts(rows: list[dict], sort: str, desc: bool) -> list[dict]:
    """Order the accounts table. An account set is small, so the shaped rows sort directly in Python."""
    keys: dict[str, Callable[[dict], Any]] = {
        "name": lambda a: a["name"].lower(),
        "kind": lambda a: a["kind"],
        "opening": lambda a: a["opening_balance_cents"],
        "opening_date": lambda a: a["opening_date"] or "",
        "balance": lambda a: a["current_balance_cents"],
        "transactions": lambda a: a["transaction_count"],
        "activity": lambda a: a["transacted_cents"],
        "status": lambda a: a["is_active"],
    }
    if sort not in ACCOUNT_SORTS:
        raise HTTPException(400, f"Sort must be one of: {', '.join(ACCOUNT_SORTS)}")
    return sorted(rows, key=keys[sort], reverse=desc)


def _account_stats(db: Session) -> dict[int, dict]:
    """Per-account: balance change up to today, transaction count, and total transacted."""
    today = date.today()
    income = income_keys(db)
    deltas = dict(
        db.execute(
            select(
                Transaction.account_id,
                func.sum(
                    delta_expression(income)
                ),
            )
            .join(Category, Transaction.category_id == Category.id)
            .where(Transaction.account_id.is_not(None), Transaction.date <= today)
            .group_by(Transaction.account_id)
        ).all()
    )
    rows = db.execute(
        select(
            Transaction.account_id,
            func.count(),
            func.sum(func.abs(Transaction.amount_cents)),
        )
        .where(Transaction.account_id.is_not(None))
        .group_by(Transaction.account_id)
    ).all()
    stats: dict[int, dict] = {}
    for acc_id, count, transacted in rows:
        stats[acc_id] = {"delta": deltas.get(acc_id, 0), "count": count, "abs": transacted or 0}
    for acc_id, delta in deltas.items():
        stats.setdefault(acc_id, {"delta": delta, "count": 0, "abs": 0})
    return stats


def _apply_account(db: Session, acc: Account, body: AccountBody) -> None:
    if body.kind not in account_type_keys(db) or not body.name.strip():
        raise ValueError("Name and a valid type are required")
    acc.name, acc.kind = body.name.strip(), body.kind
    opening = to_cents(body.opening_balance or "0")
    # A loan's opening balance is entered as the amount owed (positive), the inverse of its ledger sign.
    acc.opening_balance_cents = -opening if loan_service.is_loan(acc) else opening
    acc.opening_date = body.opening_date
    acc.is_active = body.is_active
    # Loan metadata is 1:1 with a debt account, so keep it in step with the type.
    if loan_service.is_loan(acc):
        loan_service.ensure_details(db, acc)
    else:
        loan_service.drop_details(db, acc)


def _save_account(db: Session, acc: Account, body: AccountBody) -> dict:
    with user_errors():
        _apply_account(db, acc, body)
        db.add(acc)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise ValueError(f"'{body.name.strip()}' already exists") from exc
    return _account_out(acc)


@router.get("/accounts")
def get_accounts(
    include_inactive: bool = True, sort: str = "name", dir: str = "asc", db: Session = Depends(get_db)
):
    if dir not in ("asc", "desc"):
        raise HTTPException(400, "dir must be 'asc' or 'desc'")
    stats = _account_stats(db)
    rows = [_account_out(a, stats.get(a.id)) for a in list_accounts(db, include_inactive=include_inactive)]
    return _sort_accounts(rows, sort, dir == "desc")


@router.post("/accounts", status_code=201)
def create_account(body: AccountBody, db: Session = Depends(get_db)):
    return _save_account(db, Account(), body)


@router.put("/accounts/{account_id}")
def update_account(account_id: int, body: AccountBody, db: Session = Depends(get_db)):
    acc = db.get(Account, account_id)
    if acc is None:
        raise HTTPException(404, "Account not found")
    return _save_account(db, acc, body)


@router.delete("/accounts/{account_id}", status_code=204)
def delete_account(account_id: int, db: Session = Depends(get_db)):
    acc = db.get(Account, account_id)
    if acc is not None:
        db.delete(acc)  # transactions/recurring reference accounts with ON DELETE SET NULL
        db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------------- loans


class LoanDetailsBody(BaseModel):
    loan_type: str = ""
    lender: str = ""
    original_principal: str = "0"
    rate: str = "0"  # annual percent, e.g. "6.49"
    is_interest_bearing: bool = False
    min_payment: str = "0"
    due_day: int = 0
    credit_limit: str = "0"
    reference: str = ""
    notes: str = ""


class LoanCreateBody(BaseModel):
    name: str
    owed: str = "0"
    opening_date: date | None = None
    is_active: bool = True
    details: LoanDetailsBody = LoanDetailsBody()
    disbursement_account_id: int | None = None
    disbursement_amount: str = "0"
    disbursement_date: date | None = None
    disbursement_description: str = ""


class LoanUpdateBody(BaseModel):
    name: str
    owed: str = "0"
    opening_date: date | None = None
    is_active: bool = True
    details: LoanDetailsBody = LoanDetailsBody()


class LoanPaymentBody(BaseModel):
    from_account_id: int | None = None
    amount: str = "0"
    date: date
    description: str = ""
    notes: str | None = None


class LoanTypesBody(BaseModel):
    types: list[dict]


def _details_fields(db: Session, body: LoanDetailsBody) -> dict:
    with user_errors():
        if body.loan_type and body.loan_type not in loan_type_keys(db):
            raise ValueError("Unknown loan type")
        if body.due_day and not 1 <= body.due_day <= 31:
            raise ValueError("Due day must be between 1 and 31")
        return {
            "loan_type": body.loan_type,
            "lender": body.lender.strip()[:80],
            "original_principal_cents": to_cents(body.original_principal or "0"),
            # percent to basis points: "6.49" -> 649, which is the same scaling as cents.
            "rate_bps": to_cents(body.rate or "0"),
            "is_interest_bearing": body.is_interest_bearing,
            "min_payment_cents": to_cents(body.min_payment or "0"),
            "due_day": body.due_day,
            "credit_limit_cents": to_cents(body.credit_limit or "0"),
            "reference": body.reference.strip(),
            "notes": body.notes.strip(),
        }


def _loan_or_404(db: Session, account_id: int) -> Account:
    account = db.get(Account, account_id)
    if account is None or not loan_service.is_loan(account):
        raise HTTPException(404, "Loan not found")
    return account


@router.get("/loans")
def get_loans(
    sort: str = "owed", dir: str = "desc", months: int = 12, db: Session = Depends(get_db)
):
    if dir not in ("asc", "desc"):
        raise HTTPException(400, "dir must be 'asc' or 'desc'")
    ensure_loan_config(db)
    with user_errors():
        rows = loan_service.sort_loans(loan_service.loan_summaries(db), sort, dir == "desc")
    return {
        "items": rows,
        "totals": loan_service.totals(rows),
        "trend": loan_service.debt_trend(db, max(1, min(months, 60))),
        "missing_details": loan_service.missing_details(db),
    }


@router.get("/loans/{account_id}")
def get_loan(account_id: int, db: Session = Depends(get_db)):
    ensure_loan_config(db)
    account = _loan_or_404(db, account_id)
    deltas = balance_deltas(db, {account.id})
    row = loan_service.loan_out(
        account,
        account.opening_balance_cents + deltas.get(account.id, 0),
        {t.key: t.label for t in get_loan_types(db)},
    )
    row["history"] = loan_service.history(db, account)
    return row


@router.post("/loans", status_code=201)
def create_loan(body: LoanCreateBody, db: Session = Depends(get_db)):
    ensure_loan_config(db)
    with user_errors():
        fields = _details_fields(db, body.details)
        owed = to_cents(body.owed or "0")
        if owed < 0:
            raise ValueError("Amount owed cannot be negative")
        disbursement = None
        if body.disbursement_account_id is not None:
            amount = to_cents(body.disbursement_amount or "0")
            if amount > 0:
                disbursement = {
                    "to_account_id": body.disbursement_account_id,
                    "amount_cents": amount,
                    "date": body.disbursement_date,
                    "description": body.disbursement_description,
                }
        account = loan_service.create_loan(
            db,
            name=body.name,
            owed_cents_value=owed,
            details_fields=fields,
            opening_date=body.opening_date,
            is_active=body.is_active,
            disbursement=disbursement,
        )
    return {"account_id": account.id}


@router.put("/loans/{account_id}")
def update_loan(account_id: int, body: LoanUpdateBody, db: Session = Depends(get_db)):
    account = _loan_or_404(db, account_id)
    with user_errors():
        fields = _details_fields(db, body.details)
        owed = to_cents(body.owed or "0")
        if owed < 0:
            raise ValueError("Amount owed cannot be negative")
        name = body.name.strip()
        if not name:
            raise ValueError("A loan needs a name")
        account.name = name
        account.opening_balance_cents = -owed
        account.opening_date = body.opening_date
        account.is_active = body.is_active
        details = loan_service.ensure_details(db, account)
        loan_service.apply_details(details, fields)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise ValueError(f"'{name}' already exists") from exc
    return {"account_id": account.id}


@router.delete("/loans/{account_id}", status_code=204)
def delete_loan(account_id: int, db: Session = Depends(get_db)):
    account = db.get(Account, account_id)
    if account is not None:
        db.delete(account)  # loan_details cascades; transactions keep their history with account_id NULL
        db.commit()
    return Response(status_code=204)


@router.post("/loans/{account_id}/payments", status_code=201)
def record_loan_payment(account_id: int, body: LoanPaymentBody, db: Session = Depends(get_db)):
    account = _loan_or_404(db, account_id)
    with user_errors():
        transfer_id = loan_service.record_payment(
            db,
            account,
            from_account_id=body.from_account_id,
            amount_cents=to_cents(body.amount or "0"),
            on_date=body.date,
            description=body.description,
            notes=body.notes,
        )
    return {"transfer_id": transfer_id}


@router.get("/settings/loan-types")
def get_loan_type_config(db: Session = Depends(get_db)):
    ensure_loan_config(db)
    return {"types": [{"key": t.key, "label": t.label} for t in get_loan_types(db)]}


@router.put("/settings/loan-types")
def set_loan_type_config(body: LoanTypesBody, db: Session = Depends(get_db)):
    with user_errors():
        types = [LoanType(key=str(t.get("key", "")), label=str(t.get("label", ""))) for t in body.types]
        saved = set_loan_types(db, types)
    return {"types": [{"key": t.key, "label": t.label} for t in saved]}


# -------------------------------------------------------------- transactions


class TransactionBody(BaseModel):
    date: date
    description: str
    category_id: int
    account_id: int | None = None
    amount: str
    notes: str | None = None


def _txn_input(body: TransactionBody) -> TransactionInput:
    return TransactionInput(
        date=body.date,
        description=body.description,
        category_id=body.category_id,
        account_id=body.account_id,
        amount_cents=to_cents(body.amount),
        notes=body.notes,
    )


def _txn_out(t: Transaction, tree: CategoryTree, peer: Transaction | None = None) -> dict:
    return {
        "id": t.id,
        "date": t.date.isoformat(),
        "description": t.description,
        "category_id": t.category_id,
        "category_path": tree.path(t.category_id),
        "kind": t.category.kind,
        "account_id": t.account_id,
        "account_name": t.account.name if t.account else None,
        "amount_cents": t.amount_cents,
        "notes": t.notes,
        "recurring_template_id": t.recurring_template_id,
        "recurring_description": t.recurring_template.description if t.recurring_template else None,
        "transfer_id": t.transfer_id,
        "transfer_account_id": peer.account_id if peer else None,
        "transfer_account_name": peer.account.name if peer and peer.account else None,
        "reimbursement_id": t.reimbursement_id,
        "reimbursement_account_id": peer.account_id if peer else None,
        "reimbursement_account_name": peer.account.name if peer and peer.account else None,
        "planned": t.date > date.today(),
    }


def _peer_lookup(db: Session, txns: list[Transaction]) -> dict[int, Transaction]:
    """Other leg of each transfer / reimbursement, keyed by transaction id, for the rows on this page."""
    peers: dict[int, Transaction] = {}
    for key_attr, legs_for in (
        ("transfer_id", transfer_service.legs_for),
        ("reimbursement_id", reimbursement_service.legs_for),
    ):
        ids = {getattr(t, key_attr) for t in txns if getattr(t, key_attr) is not None}
        by_group: dict[str, dict[int, Transaction]] = {}
        for leg in legs_for(db, ids):
            by_group.setdefault(getattr(leg, key_attr), {})[leg.id] = leg
        for t in txns:
            gid = getattr(t, key_attr)
            if gid is None:
                continue
            peers[t.id] = next((leg for leg_id, leg in by_group[gid].items() if leg_id != t.id), None)
    return peers


def _get_txn(db: Session, txn_id: int) -> Transaction:
    txn = db.get(Transaction, txn_id)
    if txn is None:
        raise HTTPException(404, "Transaction not found")
    return txn


@router.get("/transactions")
def list_transactions(
    db: Session = Depends(get_db),
    start: date | None = None,
    end: date | None = None,
    category_id: int | None = None,
    account_id: int | None = None,
    q: str | None = None,
    sort: str = "date",
    dir: str = "desc",
    page: int = 1,
):
    tree = category_service.load_tree(db)
    flt = txn_service.TransactionFilter(
        start=start,
        end=end,
        category_ids=tree.nodes[category_id].subtree_ids() if category_id in tree.nodes else None,
        account_id=account_id,
        search=q,
    )
    page = max(page, 1)
    items, total = txn_service.list_transactions(
        db, flt, PAGE_SIZE, (page - 1) * PAGE_SIZE, sort=sort, desc=(dir != "asc")
    )
    peers = _peer_lookup(db, items)
    return {
        "items": [_txn_out(t, tree, peers.get(t.id)) for t in items],
        "total": total,
        "page": page,
        "pages": max((total + PAGE_SIZE - 1) // PAGE_SIZE, 1),
    }


# Static paths first so "recent" is not parsed as a transaction id.
@router.get("/transactions/recent")
def recent_transactions(db: Session = Depends(get_db)):
    tree = category_service.load_tree(db)
    items = txn_service.recent_transactions(db)
    peers = _peer_lookup(db, items)
    return [_txn_out(t, tree, peers.get(t.id)) for t in items]


@router.get("/transactions/descriptions")
def descriptions(db: Session = Depends(get_db)):
    return txn_service.recent_descriptions(db)


@router.get("/transactions/duplicates")
def transaction_duplicates(
    date: date,
    amount: str,
    account_id: int | None = None,
    exclude_id: int | None = None,
    db: Session = Depends(get_db),
):
    """Existing rows matching (date, amount, account) so the form can warn before saving."""
    with user_errors():
        matches = txn_service.find_duplicates(db, date, to_cents(amount), account_id, exclude_id)
    return [
        {
            "id": t.id,
            "date": t.date.isoformat(),
            "description": t.description,
            "amount_cents": t.amount_cents,
            "account_name": t.account.name if t.account else None,
        }
        for t in matches
    ]


@router.post("/transactions", status_code=201)
def create_transaction(body: TransactionBody, db: Session = Depends(get_db)):
    with user_errors():
        txn = txn_service.create_transaction(db, _txn_input(body))
    return _txn_out(txn, category_service.load_tree(db))


@router.get("/transactions/{txn_id}")
def get_transaction(txn_id: int, db: Session = Depends(get_db)):
    txn = _get_txn(db, txn_id)
    peers = _peer_lookup(db, [txn])
    return _txn_out(txn, category_service.load_tree(db), peers.get(txn.id))


@router.put("/transactions/{txn_id}")
def update_transaction(txn_id: int, body: TransactionBody, db: Session = Depends(get_db)):
    txn = _get_txn(db, txn_id)
    with user_errors():
        txn_service.update_transaction(db, txn, _txn_input(body))
    return _txn_out(txn, category_service.load_tree(db))


@router.delete("/transactions/{txn_id}", status_code=204)
def delete_transaction(txn_id: int, db: Session = Depends(get_db)):
    txn = _get_txn(db, txn_id)
    if txn.transfer_id is not None:
        transfer_service.delete_transfer(db, txn.transfer_id)  # deleting one leg removes both
    elif txn.reimbursement_id is not None:
        reimbursement_service.un_pair(db, txn)  # delete the leg, release the other as a normal row
    else:
        txn_service.delete_transaction(db, txn)
    return Response(status_code=204)


@router.delete("/transactions")
def clear_transactions(imported_only: bool = False, db: Session = Depends(get_db)):
    """Delete every transaction (or only imported ones). Setup — categories, accounts, budgets — is kept."""
    with user_errors():
        deleted = txn_service.clear_transactions(db, imported_only=imported_only)
    return {"deleted": deleted}


# ----------------------------------------------------------------- transfers


class TransferBody(BaseModel):
    date: date
    description: str = ""
    amount: str
    from_account_id: int | None = None
    to_account_id: int | None = None
    notes: str | None = None


class ConnectTransferBody(BaseModel):
    from_id: int
    to_id: int


@router.post("/transfers", status_code=201)
def create_transfer(body: TransferBody, db: Session = Depends(get_db)):
    with user_errors():
        transfer_id = transfer_service.create_transfer(
            db,
            on_date=body.date,
            description=body.description,
            amount_cents=to_cents(body.amount),
            from_account_id=body.from_account_id,
            to_account_id=body.to_account_id,
            notes=body.notes,
        )
    return {"transfer_id": transfer_id}


@router.post("/transfers/connect")
def connect_transfer(body: ConnectTransferBody, db: Session = Depends(get_db)):
    """Link two existing rows (e.g. the two statements' sides of one movement) as a transfer."""
    first, second = _get_txn(db, body.from_id), _get_txn(db, body.to_id)
    with user_errors():
        transfer_id = transfer_service.connect_transfer(db, first, second)
    return {"transfer_id": transfer_id}


class ConnectReimbursementBody(BaseModel):
    first_id: int
    second_id: int


@router.post("/reimbursements/connect")
def connect_reimbursement(body: ConnectReimbursementBody, db: Session = Depends(get_db)):
    """Link an outlay to its repayment so both stop counting toward your budget."""
    first, second = _get_txn(db, body.first_id), _get_txn(db, body.second_id)
    with user_errors():
        reimbursement_id = reimbursement_service.connect(db, first, second)
    return {"reimbursement_id": reimbursement_id}


@router.get("/ledger/check")
def check_ledger(db: Session = Depends(get_db)):
    """Read-only integrity report over the transfer and reimbursement pairings."""
    return integrity.validate_ledger(db)


@router.get("/transfers/{transfer_id}")
def get_transfer(transfer_id: str, db: Session = Depends(get_db)):
    with user_errors():
        return transfer_service.transfer_out(db, transfer_id)


@router.put("/transfers/{transfer_id}")
def update_transfer(transfer_id: str, body: TransferBody, db: Session = Depends(get_db)):
    with user_errors():
        transfer_service.update_transfer(
            db,
            transfer_id,
            on_date=body.date,
            description=body.description,
            amount_cents=to_cents(body.amount),
            from_account_id=body.from_account_id,
            to_account_id=body.to_account_id,
            notes=body.notes,
        )
    return {"ok": True}


# ----------------------------------------------------------------- recurring


class RecurringBody(BaseModel):
    description: str
    category_id: int
    account_id: int | None = None
    amount: str
    day_of_month: int = 1
    schedule: dict | None = None
    is_active: bool = True


def _recurring_out(t: RecurringTemplate, tree: CategoryTree, income: set[str]) -> dict:
    return {
        "id": t.id,
        "description": t.description,
        "category_id": t.category_id,
        "category_path": tree.path(t.category_id),
        "is_income": bool(t.category and t.category.kind in income),
        "account_id": t.account_id,
        "account_name": t.account.name if t.account else None,
        "amount_cents": t.amount_cents,
        "day_of_month": t.day_of_month,
        "schedule": t.schedule,
        "is_active": t.is_active,
    }


def _sort_recurring(rows: list[dict], sort: str, desc: bool) -> list[dict]:
    """Order the recurring table. Repeats is left unsortable: its summary is text, not a rank."""
    keys: dict[str, Callable[[dict], Any]] = {
        "description": lambda t: t["description"].lower(),
        "category": lambda t: t["category_path"].lower(),
        "account": lambda t: (t["account_name"] or "").lower(),
        "amount": lambda t: t["amount_cents"],
        "status": lambda t: t["is_active"],
    }
    if sort not in keys:
        raise HTTPException(400, f"Sort must be one of: {', '.join(keys)}")
    return sorted(rows, key=keys[sort], reverse=desc)


def _apply_recurring(tpl: RecurringTemplate, body: RecurringBody) -> None:
    if not body.description.strip():
        raise ValueError("Description and category are required")
    if body.schedule is not None:
        tpl.schedule = validate_schedule(body.schedule)
    else:
        if not 1 <= body.day_of_month <= 31:
            raise ValueError("Day of month must be 1-31")
        tpl.schedule = None
    tpl.day_of_month = body.day_of_month
    tpl.description = body.description.strip()
    tpl.category_id = body.category_id
    tpl.account_id = body.account_id
    tpl.amount_cents = to_cents(body.amount)
    tpl.is_active = body.is_active


@router.get("/recurring")
def get_recurring(sort: str = "description", dir: str = "asc", db: Session = Depends(get_db)):
    if dir not in ("asc", "desc"):
        raise HTTPException(400, "dir must be 'asc' or 'desc'")
    tree = category_service.load_tree(db)
    income = income_keys(db)
    rows = [_recurring_out(t, tree, income) for t in list_templates(db)]
    return _sort_recurring(rows, sort, dir == "desc")


@router.post("/recurring", status_code=201)
def create_recurring(body: RecurringBody, db: Session = Depends(get_db)):
    tpl = RecurringTemplate()
    with user_errors():
        _apply_recurring(tpl, body)
    db.add(tpl)
    db.commit()
    return {"id": tpl.id}


@router.put("/recurring/{tpl_id}")
def update_recurring(tpl_id: int, body: RecurringBody, db: Session = Depends(get_db)):
    tpl = db.get(RecurringTemplate, tpl_id)
    if tpl is None:
        raise HTTPException(404, "Template not found")
    with user_errors():
        _apply_recurring(tpl, body)
    db.commit()
    return {"id": tpl.id}


@router.delete("/recurring/{tpl_id}", status_code=204)
def delete_recurring(tpl_id: int, db: Session = Depends(get_db)):
    tpl = db.get(RecurringTemplate, tpl_id)
    if tpl is not None:
        db.delete(tpl)
        db.commit()
    return Response(status_code=204)


# -------------------------------------------------------------------- import

MAX_UPLOAD_BYTES = 2_000_000


class ImportRow(BaseModel):
    date: date
    description: str
    amount_cents: int
    direction: str
    category_id: int
    key: str
    recurring_template_id: int | None = None


class ImportCommitBody(BaseModel):
    account_id: int | None = None
    rows: list[ImportRow]


@router.post("/import/preview")
async def import_preview(
    db: Session = Depends(get_db),
    file: UploadFile = File(...),
    account_id: int | None = Form(None),
    amount_sign: str = Form("positive_is_expense"),
):
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "File is too large (2 MB max)")
    with user_errors():
        rows = importing.parse_csv(content, positive_is_expense=amount_sign == "positive_is_expense")
        rows = importing.prepare_preview(db, rows, account_id)
    if not rows:
        raise HTTPException(400, "No transactions found in that file")
    return [
        {
            "date": r.date.isoformat(),
            "description": r.description,
            "amount_cents": r.amount_cents,
            "direction": r.direction,
            "category_id": r.category_id,
            "duplicate": r.duplicate,
            "key": r.key,
        }
        for r in rows
    ]


@router.post("/import/commit")
def import_commit(body: ImportCommitBody, db: Session = Depends(get_db)):
    tree = category_service.load_tree(db)
    for i, row in enumerate(body.rows, start=1):
        node = tree.nodes.get(row.category_id)
        if node is None or node.depth < 1:
            raise HTTPException(400, f"Row {i} ({row.description}) has no category; nothing was imported")
        if row.direction not in ("in", "out"):
            raise HTTPException(400, f"Row {i} has an invalid direction")
    parsed = [
        importing.ParsedRow(
            r.date,
            r.description,
            r.amount_cents,
            r.direction,
            category_id=r.category_id,
            key=r.key,
            recurring_template_id=r.recurring_template_id,
        )
        for r in body.rows
    ]
    return {"imported": importing.commit_rows(db, parsed, body.account_id)}


class ApplyRulesRow(BaseModel):
    date: date
    description: str
    amount_cents: int
    direction: str
    category_id: int | None = None


class ApplyRulesBody(BaseModel):
    account_id: int | None = None
    rows: list[ApplyRulesRow]


@router.post("/import/apply-rules")
def apply_import_rules(body: ApplyRulesBody, db: Session = Depends(get_db)):
    """Fill categories a preview left blank from the current rules (used after adding a rule)."""
    with user_errors():
        parsed = [
            importing.ParsedRow(r.date, r.description, r.amount_cents, r.direction, category_id=r.category_id)
            for r in body.rows
        ]
        importing.apply_rules(db, parsed, body.account_id)
    return {"category_ids": [r.category_id for r in parsed]}


class ImportRuleBody(BaseModel):
    match_text: str = ""
    amount: str | None = None
    account_id: int
    day_from: int | None = None
    day_to: int | None = None
    category_id: int
    sort_order: int = 0
    is_active: bool = True


def _rule_out(rule: ImportRule, tree: CategoryTree) -> dict:
    return {
        "id": rule.id,
        "match_text": rule.match_text,
        "amount_cents": rule.amount_cents,
        "account_id": rule.account_id,
        "account_name": rule.account.name if rule.account else None,
        "day_from": rule.day_from,
        "day_to": rule.day_to,
        "category_id": rule.category_id,
        "category_path": tree.path(rule.category_id),
        "sort_order": rule.sort_order,
        "is_active": rule.is_active,
    }


def _rule_amount_cents(body: ImportRuleBody) -> int | None:
    return to_cents(body.amount) if body.amount else None


@router.get("/import-rules")
def list_import_rules(db: Session = Depends(get_db)):
    tree = category_service.load_tree(db)
    return [_rule_out(r, tree) for r in import_rules.list_rules(db)]


@router.post("/import-rules", status_code=201)
def create_import_rule(body: ImportRuleBody, db: Session = Depends(get_db)):
    with user_errors():
        rule = import_rules.create_rule(
            db,
            body.match_text,
            body.account_id,
            body.category_id,
            body.day_from,
            body.day_to,
            _rule_amount_cents(body),
        )
    return {"id": rule.id}


@router.put("/import-rules/{rule_id}")
def update_import_rule(rule_id: int, body: ImportRuleBody, db: Session = Depends(get_db)):
    with user_errors():
        import_rules.update_rule(
            db,
            rule_id,
            body.match_text,
            body.account_id,
            body.category_id,
            body.day_from,
            body.day_to,
            body.sort_order,
            body.is_active,
            _rule_amount_cents(body),
        )
    return {"ok": True}


@router.delete("/import-rules/{rule_id}", status_code=204)
def delete_import_rule(rule_id: int, db: Session = Depends(get_db)):
    with user_errors():
        import_rules.delete_rule(db, rule_id)
    return Response(status_code=204)


@router.post("/import-rules/{rule_id}/move")
def move_import_rule(rule_id: int, body: dict, db: Session = Depends(get_db)):
    with user_errors():
        import_rules.swap_order(db, rule_id, -1 if body.get("dir") == "up" else 1)
    return {"ok": True}


# ------------------------------------------------------------------- budgets


class BudgetAmountBody(BaseModel):
    amount: str | None = None  # None clears the override (back to the category default)


@router.get("/budget")
def get_budget(month: str | None = None, db: Session = Depends(get_db)):
    """Budget vs actual for one month (``YYYY-MM``, default: this month), with the zero-based check."""
    with user_errors():
        first = budgets.parse_month(month or date.today().strftime("%Y-%m"))
    data = budgets.build_month(db, first)
    return {
        "month": first.strftime("%Y-%m"),
        "income_budget": data.income_budget,
        "expense_budget": data.expense_budget,
        "income_actual": data.income_actual,
        "expense_actual": data.expense_actual,
        "unassigned": data.unassigned_cents,
        "type_totals": data.type_totals,
        "lines": [
            {
                "category_id": line.category_id,
                "name": line.name,
                "parent_id": line.parent_id,
                "depth": line.depth,
                "kind": line.kind,
                "has_children": line.has_children,
                "is_active": line.is_active,
                "default_cents": line.default_cents,
                "budget_cents": line.budget_cents,
                "is_override": line.is_override,
                "actual_cents": line.actual_cents,
                "recurring_cents": line.recurring_cents,
                "remaining_cents": line.remaining_cents,
            }
            for line in data.lines
        ],
    }


@router.put("/budget/{month}/{category_id}")
def set_budget(month: str, category_id: int, body: BudgetAmountBody, db: Session = Depends(get_db)):
    with user_errors():
        budgets.set_budget(
            db,
            budgets.parse_month(month),
            category_id,
            None if body.amount is None else to_cents(body.amount or "0"),
        )
    return {"ok": True}


@router.post("/budget/{month}/copy-previous")
def copy_previous_budget(month: str, db: Session = Depends(get_db)):
    with user_errors():
        changed = budgets.copy_previous(db, budgets.parse_month(month))
    return {"changed": changed}


class GenerateBudgetBody(BaseModel):
    values: dict[int, int]  # leaf category_id -> budget cents


@router.post("/budget/{month}/generate")
def generate_budget(month: str, body: GenerateBudgetBody, db: Session = Depends(get_db)):
    with user_errors():
        changed = budgets.generate(db, budgets.parse_month(month), body.values)
    return {"ok": True, "changed": changed}


# ------------------------------------------------------------------- reports


@router.get("/reports")
def get_report(db: Session = Depends(get_db), month: int | None = None, as_of: date | None = None):
    """Rolling report over the last ``WINDOW_MONTHS`` months.

    ``month`` is a 1-based position in that window and only drives the category chart; it defaults
    to the last month with activity. ``as_of`` pins the end of the window instead of today.
    """
    anchor = as_of or date.today()
    report = reports.budget_report(db, as_of=anchor)
    n = len(report.window)
    default = (report.last_active_index + 1) if report.last_active_index is not None else n
    m = min(max((month or default) - 1, 0), n - 1)
    return {
        "months": report.months,
        "month": m + 1,
        "net_months": report.net_months,
        "expense_budgets": report.expense_budgets,
        "income_budgets": report.income_budgets,
        "net_budgets": [
            i - e for i, e in zip(report.income_budgets, report.expense_budgets, strict=True)
        ],
        "expense_budget": report.expense_budget,
        "income_budget": report.income_budget,
        "avg_expense": report.avg_expense,
        "type_totals": report.type_totals,
        "rows": [
            {
                "category_id": r.category_id,
                "name": r.name,
                "depth": r.depth,
                "kind": r.kind,
                "is_income": r.is_income,
                "has_children": r.has_children,
                "months": r.months,
                "budgets": r.budgets,
                "budget": r.budget,
                "total": r.total,
                "avg": r.avg,
                "variance": r.variance,
                "status": r.status,
            }
            for r in report.rows
        ],
        "chart": reports.chart_payload(report, m),
    }


# ------------------------------------------------------------------ cash flow


@router.get("/cashflow")
def get_cashflow(db: Session = Depends(get_db), account_id: int | None = None):
    accounts = list_accounts(db)
    account = db.get(Account, account_id) if account_id else None
    account = account or next((a for a in accounts if a.kind == "bank"), None)
    if account is None:
        return {"account": None, "ledger": None}
    ledger = build_ledger(db, account)

    def row(r) -> dict:
        return {
            "txn_id": r.txn.id,
            "date": r.txn.date.isoformat(),
            "description": r.txn.description,
            "delta_cents": r.delta_cents,
            "balance_cents": r.balance_cents,
            "is_planned": r.is_planned,
            "level": r.level,
        }

    return {
        "account": _account_out(account),
        "ledger": {
            "rows": [row(r) for r in ledger.rows],
            "current_balance_cents": ledger.current_balance_cents,
            "projected_balance_cents": ledger.projected_balance_cents,
            "lowest": row(ledger.lowest) if ledger.lowest else None,
            "low_threshold_cents": ledger.low_threshold_cents,
            "warn_threshold_cents": ledger.warn_threshold_cents,
        },
    }


# ------------------------------------------------------------------- settings


class ThresholdsBody(BaseModel):
    low: str
    warn: str


@router.put("/settings/thresholds")
def set_thresholds(body: ThresholdsBody, db: Session = Depends(get_db)):
    with user_errors():
        low, warn = to_cents(body.low), to_cents(body.warn)
    set_int_setting(db, LOW_BALANCE_KEY, low)
    set_int_setting(db, WARN_BALANCE_KEY, warn)
    return {"low_balance_cents": low, "warn_balance_cents": warn}


class CategoryConfigBody(BaseModel):
    levels: list[str]


@router.get("/settings/category-config")
def get_category_config(db: Session = Depends(get_db)):
    ensure_category_config(db)
    return {
        "types": [{"key": t.key, "label": t.label, "direction": t.direction} for t in get_types(db)],
        "levels": get_levels(db),
    }


@router.put("/settings/category-config")
def set_category_config(body: CategoryConfigBody, db: Session = Depends(get_db)):
    with user_errors():
        levels = set_levels(db, body.levels)
    return {"levels": levels}


@router.get("/settings/account-config")
def get_account_config(db: Session = Depends(get_db)):
    ensure_account_config(db)
    return {"types": [{"key": t.key, "label": t.label} for t in get_account_types(db)]}


# --------------------------------------------------------------------- plans


class PlanBody(BaseModel):
    name: str
    type: str
    account_id: int | None = None
    start_date: date | None = None
    end_date: date | None = None
    notes: str = ""
    status: str = "active"
    config: dict = {}


class PlanItemBody(BaseModel):
    date: datetime.date | None = None
    description: str = ""
    category_id: int | None = None
    account_id: int | None = None
    amount: str = "0"
    direction: str = "out"
    item_kind: str = "custom"
    matched_transaction_id: int | None = None


@router.get("/plan-types")
def get_plan_types():
    """The registry of plan behaviours, so the UI can render create/edit forms generically."""
    return type_payloads()


@router.get("/plans")
def list_plans(db: Session = Depends(get_db)):
    return [plan_service.plan_out(db, p) for p in plan_service.list_plans(db)]


@router.get("/plans/{plan_id}")
def get_plan(plan_id: int, db: Session = Depends(get_db)):
    with user_errors():
        plan = plan_service.get_plan(db, plan_id)
        return plan_service.plan_out(db, plan, detail=True)


@router.post("/plans", status_code=201)
def create_plan(body: PlanBody, db: Session = Depends(get_db)):
    with user_errors():
        plan = plan_service.create_plan(
            db,
            name=body.name,
            type=body.type,
            account_id=body.account_id,
            start_date=body.start_date,
            end_date=body.end_date,
            notes=body.notes,
            config=body.config,
        )
    return {"id": plan.id}


@router.put("/plans/{plan_id}")
def update_plan(plan_id: int, body: PlanBody, db: Session = Depends(get_db)):
    with user_errors():
        plan = plan_service.get_plan(db, plan_id)
        plan_service.update_plan(
            db,
            plan,
            name=body.name,
            account_id=body.account_id,
            start_date=body.start_date,
            end_date=body.end_date,
            notes=body.notes,
            status=body.status,
            config=body.config,
        )
    return {"id": plan.id}


@router.delete("/plans/{plan_id}", status_code=204)
def delete_plan(plan_id: int, db: Session = Depends(get_db)):
    with user_errors():
        plan_service.delete_plan(db, plan_service.get_plan(db, plan_id))
    return Response(status_code=204)


def _item_fields(body: PlanItemBody) -> dict:
    return {
        "date": body.date,
        "description": body.description,
        "category_id": body.category_id,
        "account_id": body.account_id,
        "amount_cents": to_cents(body.amount or "0"),
        "direction": body.direction,
        "item_kind": body.item_kind,
        "matched_transaction_id": body.matched_transaction_id,
    }


@router.post("/plans/{plan_id}/items", status_code=201)
def create_plan_item(plan_id: int, body: PlanItemBody, db: Session = Depends(get_db)):
    with user_errors():
        plan = plan_service.get_plan(db, plan_id)
        item = plan_service.create_item(db, plan, **_item_fields(body))
    return {"id": item.id}


@router.put("/plans/{plan_id}/items/{item_id}")
def update_plan_item(plan_id: int, item_id: int, body: PlanItemBody, db: Session = Depends(get_db)):
    with user_errors():
        item = plan_service.get_item(db, item_id)
        if item.plan_id != plan_id:
            raise HTTPException(404, "Plan item not found")
        plan_service.update_item(db, item, **_item_fields(body))
    return {"ok": True}


@router.delete("/plans/{plan_id}/items/{item_id}", status_code=204)
def delete_plan_item(plan_id: int, item_id: int, db: Session = Depends(get_db)):
    with user_errors():
        item = plan_service.get_item(db, item_id)
        if item.plan_id != plan_id:
            raise HTTPException(404, "Plan item not found")
        plan_service.delete_item(db, item)
    return Response(status_code=204)
