"""Reimbursements: a payable expense matched with its later repayment.

You pay for something on someone's behalf (an ordinary expense that COUNTS in your budget); later
they pay you back. When the two rows are connected they share a ``reimbursement_id`` and are both
excluded from budgets and reports, so fully-reimbursed spending nets to zero. Until then the outlay
stays a normal expense and any repayment you've received reads as a refund on the same category.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models import REIMBURSEMENT, Category, Transaction
from app.services import transfers as transfer_service

CATEGORY_NAME = "Reimbursements"


class ReimbursementError(ValueError):
    """A reimbursement rule was violated (shown to the user)."""


def ensure_reimbursement_category(db: Session) -> Category:
    """The (visible) "Reimbursements" leaf, nested under the "Transfer" category.

    ``kind = reimbursement``: unlike transfers, an unpaired reimbursement leg is a normal expense
    (or refund), so it counts in budgets until the pair is connected. Direction follows category
    type: money out is positive.
    """
    section = transfer_service.ensure_transfer_section(db)
    leaves = list(
        db.scalars(
            select(Category)
            .where(Category.kind == REIMBURSEMENT, Category.parent_id == section.id)
            .order_by(Category.id)
        )
    )
    if len(leaves) > 1:
        # A duplicate leaf can sneak in via past migrations. Collapse onto the leaf a transaction
        # (or recurring rule / import rule) actually references, else the first; drop the extras.
        usage = {
            c.id: count
            for c, count in db.execute(
                select(Transaction.category_id, func.count())
                .where(Transaction.category_id.in_([c.id for c in leaves]))
                .group_by(Transaction.category_id)
            )
        }
        keeper = max(leaves, key=lambda c: (usage.get(c.id, 0), -c.id))
        for extra in (c for c in leaves if c.id != keeper.id):
            db.execute(
                update(Transaction).where(Transaction.category_id == extra.id).values(category_id=keeper.id)
            )
            db.delete(extra)
        leaves = [keeper]
    leaf = leaves[0] if leaves else None
    if leaf is None:
        leaf = Category(
            name=CATEGORY_NAME, parent_id=section.id, kind=REIMBURSEMENT, is_active=True, sort_order=10_001
        )
        db.add(leaf)
        db.commit()
    leaf.is_active = True
    return leaf


def is_paired(txn: Transaction) -> bool:
    return txn.reimbursement_id is not None


def legs(db: Session, reimbursement_id: str) -> list[Transaction]:
    return list(db.scalars(select(Transaction).where(Transaction.reimbursement_id == reimbursement_id)))


def legs_for(db: Session, reimbursement_ids: set[str]) -> list[Transaction]:
    if not reimbursement_ids:
        return []
    return list(
        db.scalars(select(Transaction).where(Transaction.reimbursement_id.in_(reimbursement_ids))).unique()
    )


def connect(db: Session, first: Transaction, second: Transaction) -> str:
    """Mark an outgoing expense and its incoming repayment as one reimbursement.

    Both rows must already be tagged with the reimbursement category, be the matching amount, and be
    opposite in sign (the outlay positive, the repayment negative). Neither may be paired already.
    """
    if first.id == second.id:
        raise ReimbursementError("Pick two different transactions")
    if first.reimbursement_id is not None or second.reimbursement_id is not None:
        raise ReimbursementError("One of those is already part of a reimbursement")
    if first.category.kind != REIMBURSEMENT or second.category.kind != REIMBURSEMENT:
        raise ReimbursementError("Both rows must be tagged as a reimbursement")
    if abs(first.amount_cents) != abs(second.amount_cents):
        raise ReimbursementError("The two amounts must match")
    if (first.amount_cents < 0) == (second.amount_cents < 0):
        raise ReimbursementError("One row must be the outlay and the other the repayment")
    reimbursement_id = str(uuid.uuid4())
    for txn in (first, second):
        txn.reimbursement_id = reimbursement_id
    db.commit()
    return reimbursement_id


def un_pair(db: Session, leg: Transaction) -> None:
    """Delete ``leg`` and release its partner back to a normal (unpaired) transaction."""
    partner = None
    if leg.reimbursement_id is not None:
        pair = legs(db, leg.reimbursement_id)
        partner = next((t for t in pair if t.id != leg.id), None)
    db.delete(leg)
    if partner is not None:
        partner.reimbursement_id = None
    db.commit()