"""Ledger integrity: the structural rules a paired entry must hold, checked instead of assumed.

Balances are worked out from the rows, never stored, so a pairing that came out half-written is the
one mistake that quietly moves money the wrong way and looks fine everywhere else. This module only
reads; it reports what looks broken and leaves the fix to a person.
"""

from __future__ import annotations

from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import TRANSFER, Transaction

MAX_REPORTED_IDS = 20


def _issue(code: str, message: str, txns: list[Transaction]) -> dict:
    return {
        "code": code,
        "message": message,
        "count": len(txns),
        "txn_ids": [txn.id for txn in txns[:MAX_REPORTED_IDS]],
    }


def _opposed(first: Transaction, second: Transaction) -> bool:
    """True when the two legs move in opposite directions by the same amount."""
    return (first.amount_cents < 0) != (second.amount_cents < 0) and abs(first.amount_cents) == abs(
        second.amount_cents
    )


def validate_ledger(db: Session) -> dict:
    """Walk every transfer and reimbursement pairing and report what would make a balance wrong."""
    rows = list(db.scalars(select(Transaction)))
    transfers: dict[str, list[Transaction]] = defaultdict(list)
    reimbursements: dict[str, list[Transaction]] = defaultdict(list)
    double_linked: list[Transaction] = []
    for txn in rows:
        if txn.transfer_id is not None:
            transfers[txn.transfer_id].append(txn)
        if txn.reimbursement_id is not None:
            reimbursements[txn.reimbursement_id].append(txn)
        if txn.transfer_id is not None and txn.reimbursement_id is not None:
            double_linked.append(txn)

    lonely_transfers: list[Transaction] = []
    same_account: list[Transaction] = []
    unopposed: list[Transaction] = []
    untagged: list[Transaction] = []
    for legs in transfers.values():
        if len(legs) != 2:
            lonely_transfers.extend(legs)
            continue
        first, second = legs
        if first.account_id is None or second.account_id is None or first.account_id == second.account_id:
            same_account.extend(legs)
        if not _opposed(first, second):
            unopposed.extend(legs)
        if any(leg.category is None or leg.category.kind != TRANSFER for leg in legs):
            untagged.extend(legs)

    lonely_reimbursements: list[Transaction] = []
    for legs in reimbursements.values():
        if len(legs) != 2:
            lonely_reimbursements.extend(legs)
        elif not _opposed(legs[0], legs[1]):
            unopposed.extend(legs)

    issues = [
        _issue(
            "transfer_legs",
            "A transfer needs exactly two legs; these belong to a pairing of a different size.",
            lonely_transfers,
        ),
        _issue(
            "transfer_accounts",
            "Both legs of a transfer must sit on different accounts.",
            same_account,
        ),
        _issue(
            "pair_signs",
            "The legs of a pairing must be equal in amount and opposite in direction.",
            unopposed,
        ),
        _issue(
            "transfer_category",
            "Transfer legs must keep the transfer category, or their balance is worked out with the wrong sign.",
            untagged,
        ),
        _issue(
            "reimbursement_legs",
            "A reimbursement needs exactly two legs; these belong to a pairing of a different size.",
            lonely_reimbursements,
        ),
        _issue(
            "double_linked",
            "A row cannot be both a transfer leg and a reimbursement.",
            double_linked,
        ),
    ]
    return {
        "ok": not any(issue["count"] for issue in issues),
        "issues": [issue for issue in issues if issue["count"]],
        "scanned": {
            "transactions": len(rows),
            "transfers": len(transfers),
            "reimbursements": len(reimbursements),
        },
    }
