"""Account-to-account transfers, stored as two linked transaction legs.

A transfer is not income or expense: it moves money between two of your own accounts, so both
legs share a ``transfer_id`` and use a hidden system category of kind ``transfer``. Balances still
move (the outgoing leg is negative, the incoming leg positive); budgets and reports ignore them.
"""

from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import TRANSFER, Account, Category, Transaction
from app.services.category_config import income_keys

SECTION_NAME = "Transfer"
CATEGORY_NAME = "Between accounts"
DEFAULT_DESCRIPTION = "Transfer"


class TransferError(ValueError):
    """A transfer rule was violated (shown to the user)."""


def ensure_transfer_section(db: Session) -> Category:
    """The top-level "Transfer" category that holds the transfer and reimbursement sub-categories."""
    section = db.scalars(
        select(Category).where(Category.kind == TRANSFER, Category.parent_id.is_(None))
    ).first()
    if section is None:
        section = Category(name=SECTION_NAME, kind=TRANSFER, is_active=True, sort_order=10_000)
        db.add(section)
        db.flush()
    section.is_active = True
    return section


def ensure_transfer_category(db: Session) -> Category:
    """The "Between accounts" leaf every transfer leg points at.

    ``kind == transfer`` makes it neither income nor expense, so budgets and reports exclude it
    whether a leg is a pending import (no ``transfer_id`` yet) or part of a connected pair. It is
    active/visible so an importer can tag a row as a transfer and connect the counterpart later.
    """
    section = ensure_transfer_section(db)
    leaf = db.scalars(
        select(Category).where(Category.kind == TRANSFER, Category.parent_id == section.id)
    ).first()
    if leaf is None:
        leaf = Category(name=CATEGORY_NAME, parent_id=section.id, kind=TRANSFER, is_active=True, sort_order=10_000)
        db.add(leaf)
        db.commit()
    leaf.is_active = True
    return leaf


def is_transfer(txn: Transaction) -> bool:
    return txn.transfer_id is not None


def legs(db: Session, transfer_id: str) -> list[Transaction]:
    return list(db.scalars(select(Transaction).where(Transaction.transfer_id == transfer_id)))


def legs_for(db: Session, transfer_ids: set[str]) -> list[Transaction]:
    if not transfer_ids:
        return []
    return list(db.scalars(select(Transaction).where(Transaction.transfer_id.in_(transfer_ids))).unique())


def _money_in(db: Session, txn: Transaction) -> bool:
    """Whether this row currently reads as money *into* its account (by category direction)."""
    return txn.amount_cents >= 0 if txn.category.kind in income_keys(db) else txn.amount_cents < 0


def _validate_accounts(db: Session, from_account_id: int | None, to_account_id: int | None) -> None:
    if from_account_id is None or to_account_id is None:
        raise TransferError("Choose both accounts for a transfer")
    if from_account_id == to_account_id:
        raise TransferError("A transfer needs two different accounts")
    for account_id in (from_account_id, to_account_id):
        if db.get(Account, account_id) is None:
            raise TransferError("Account not found")


def _amount_cents(amount_cents: int) -> int:
    amount = abs(amount_cents)
    if amount == 0:
        raise TransferError("A transfer amount must be greater than zero")
    return amount


def create_transfer(
    db: Session,
    *,
    on_date: date,
    description: str,
    amount_cents: int,
    from_account_id: int | None,
    to_account_id: int | None,
    notes: str | None = None,
) -> str:
    amount = _amount_cents(amount_cents)
    _validate_accounts(db, from_account_id, to_account_id)
    description = (description or "").strip()[:200] or DEFAULT_DESCRIPTION
    notes = (notes or "").strip() or None
    category = ensure_transfer_category(db)
    transfer_id = str(uuid.uuid4())
    db.add_all(
        [
            Transaction(
                date=on_date,
                description=description,
                category_id=category.id,
                account_id=from_account_id,
                amount_cents=-amount,
                notes=notes,
                transfer_id=transfer_id,
            ),
            Transaction(
                date=on_date,
                description=description,
                category_id=category.id,
                account_id=to_account_id,
                amount_cents=amount,
                notes=notes,
                transfer_id=transfer_id,
            ),
        ]
    )
    db.commit()
    return transfer_id


def update_transfer(
    db: Session,
    transfer_id: str,
    *,
    on_date: date,
    description: str,
    amount_cents: int,
    from_account_id: int | None,
    to_account_id: int | None,
    notes: str | None = None,
) -> None:
    pair = legs(db, transfer_id)
    if len(pair) != 2:
        raise TransferError("Transfer not found")
    amount = _amount_cents(amount_cents)
    _validate_accounts(db, from_account_id, to_account_id)
    description = (description or "").strip()[:200] or DEFAULT_DESCRIPTION
    notes = (notes or "").strip() or None
    outgoing = next(t for t in pair if t.amount_cents < 0)
    incoming = next(t for t in pair if t.amount_cents >= 0)
    for txn, account_id, signed in ((outgoing, from_account_id, -amount), (incoming, to_account_id, amount)):
        txn.date = on_date
        txn.description = description
        txn.account_id = account_id
        txn.amount_cents = signed
        txn.notes = notes
    db.commit()


def delete_transfer(db: Session, transfer_id: str) -> None:
    for txn in legs(db, transfer_id):
        db.delete(txn)
    db.commit()


def connect_transfer(db: Session, first: Transaction, second: Transaction) -> str:
    """Mark two existing rows (e.g. imported from two statements) as the two legs of one transfer.

    Direction is inferred from what each row already does to its account, so one must be money out
    and the other money in, for the same amount, on different accounts.
    """
    if first.id == second.id:
        raise TransferError("Pick two different transactions")
    if first.transfer_id is not None or second.transfer_id is not None:
        raise TransferError("One of those is already part of a transfer")
    if first.account_id is None or second.account_id is None:
        raise TransferError("Both rows need an account before you can connect them")
    if first.account_id == second.account_id:
        raise TransferError("A transfer needs two different accounts")
    first_in, second_in = _money_in(db, first), _money_in(db, second)
    if first_in == second_in:
        raise TransferError("One row must be money out and the other money in")
    if abs(first.amount_cents) != abs(second.amount_cents):
        raise TransferError("The two amounts must match")
    amount = abs(first.amount_cents)
    if amount == 0:
        raise TransferError("A transfer amount must be greater than zero")
    if first.category.kind == TRANSFER and second.category.kind == TRANSFER:
        # Both rows are already transfer-tagged (e.g. imported as pending legs); the sign holds the
        # direction, so the outgoing leg is the negative one.
        outgoing, incoming = (first, second) if first.amount_cents < 0 else (second, first)
    else:
        outgoing, incoming = (second, first) if first_in else (first, second)
    category = ensure_transfer_category(db)
    transfer_id = str(uuid.uuid4())
    for txn, signed in ((outgoing, -amount), (incoming, amount)):
        txn.category_id = category.id
        txn.amount_cents = signed
        txn.transfer_id = transfer_id
    db.commit()
    return transfer_id


def transfer_out(db: Session, transfer_id: str) -> dict:
    pair = legs(db, transfer_id)
    outgoing = next((t for t in pair if t.amount_cents < 0), None)
    incoming = next((t for t in pair if t.amount_cents >= 0), None)
    if outgoing is None or incoming is None:
        raise TransferError("Transfer not found")
    return {
        "transfer_id": transfer_id,
        "date": outgoing.date.isoformat(),
        "description": outgoing.description,
        "amount_cents": abs(outgoing.amount_cents),
        "from_account_id": outgoing.account_id,
        "to_account_id": incoming.account_id,
        "notes": outgoing.notes,
    }
