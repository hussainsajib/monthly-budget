"""Custom import rules: description/account/date matching that assigns a category.

Rules back-stops the learned-from-history suggestion in the import preview: when history has no
answer for a transaction, the first active rule whose conditions match supplies the category.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Account, ImportRule
from app.services import transfers
from app.services.categories import load_tree
from app.services.loans import is_loan


class RuleError(ValueError):
    """A rule violates a business rule (shown to the user)."""


def active_rules(db: Session) -> list[ImportRule]:
    """Ordered rules that may fire, most-specific order first (lowest sort_order)."""
    return [
        r
        for r in db.scalars(
            select(ImportRule).where(ImportRule.is_active.is_(True)).order_by(ImportRule.sort_order, ImportRule.id)
        )
    ]


def list_rules(db: Session) -> list[ImportRule]:
    return list(db.scalars(select(ImportRule).order_by(ImportRule.sort_order, ImportRule.id)))


def _validate(
    db: Session,
    match_text: str,
    amount_cents: int | None,
    account_id: int,
    category_id: int | None,
    day_from: int | None,
    day_to: int | None,
    loan_account_id: int | None = None,
) -> tuple[str, int]:
    text = match_text.strip()
    if len(text) > 256:
        raise RuleError("Description match must be 256 characters or fewer")
    if not text and amount_cents is None and day_from is None and day_to is None:
        raise RuleError("Add at least one of: description text, an amount, or a day")
    if db.get(Account, account_id) is None:
        raise RuleError("Pick an account")
    if day_from is not None and not 1 <= day_from <= 31:
        raise RuleError("Day of month must be between 1 and 31")
    if day_to is not None and not 1 <= day_to <= 31:
        raise RuleError("Day of month must be between 1 and 31")
    if day_from is not None and day_to is not None and day_from > day_to:
        raise RuleError("The start day is after the end day")
    if loan_account_id is not None:
        loan = db.get(Account, loan_account_id)
        if loan is None or not is_loan(loan):
            raise RuleError("Pick a loan account for the payment")
        if loan_account_id == account_id:
            raise RuleError("A payment cannot go to the account it comes from")
        return text[:256], transfers.ensure_transfer_category(db, commit=False).id
    node = load_tree(db).nodes.get(category_id) if category_id is not None else None
    if node is None or node.depth < 1:
        raise RuleError("Pick a category, not a section")
    return text[:256], category_id


def _next_sort(db: Session) -> int:
    return (db.scalar(select(ImportRule.sort_order).order_by(ImportRule.sort_order.desc())) or 0) + 10


def create_rule(
    db: Session,
    match_text: str,
    account_id: int,
    category_id: int | None,
    day_from: int | None = None,
    day_to: int | None = None,
    amount_cents: int | None = None,
    loan_account_id: int | None = None,
) -> ImportRule:
    text, category_id = _validate(
        db, match_text, amount_cents, account_id, category_id, day_from, day_to, loan_account_id
    )
    rule = ImportRule(
        match_text=text,
        amount_cents=abs(amount_cents) if amount_cents is not None else None,
        account_id=account_id,
        category_id=category_id,
        loan_account_id=loan_account_id,
        day_from=day_from,
        day_to=day_to,
        sort_order=_next_sort(db),
    )
    db.add(rule)
    db.commit()
    return rule


def update_rule(
    db: Session,
    rule_id: int,
    match_text: str,
    account_id: int,
    category_id: int | None,
    day_from: int | None,
    day_to: int | None,
    sort_order: int = 0,
    is_active: bool = True,
    amount_cents: int | None = None,
    loan_account_id: int | None = None,
) -> ImportRule:
    rule = db.get(ImportRule, rule_id)
    if rule is None:
        raise RuleError("Rule not found")
    rule.match_text, category_id = _validate(
        db, match_text, amount_cents, account_id, category_id, day_from, day_to, loan_account_id
    )
    rule.amount_cents = abs(amount_cents) if amount_cents is not None else None
    rule.account_id, rule.category_id, rule.loan_account_id = account_id, category_id, loan_account_id
    rule.day_from, rule.day_to, rule.is_active = day_from, day_to, is_active
    rule.sort_order = int(sort_order)
    db.commit()
    return rule


def delete_rule(db: Session, rule_id: int) -> None:
    rule = db.get(ImportRule, rule_id)
    if rule is not None:
        db.delete(rule)
        db.commit()


def swap_order(db: Session, rule_id: int, direction: int) -> None:
    """Move ``rule_id`` up (-1) or down (+1) in precedence, swapping its sort_order with a neighbour."""
    rules = list_rules(db)
    index = next((i for i, r in enumerate(rules) if r.id == rule_id), None)
    if index is None:
        raise RuleError("Rule not found")
    other = index + direction
    if other < 0 or other >= len(rules):
        return
    rules[index].sort_order, rules[other].sort_order = rules[other].sort_order, rules[index].sort_order
    db.commit()


def _phrases(match_text: str) -> list[str]:
    """Split a rule's description match on ``|``; any non-empty phrase may match (OR semantics)."""
    return [p.strip().casefold() for p in match_text.split("|") if p.strip()]


def match_rule(
    rules: list[ImportRule], description: str, account_id: int | None, when: date, amount_cents: int | None = None
) -> ImportRule | None:
    """Return the first rule matching this row, or None."""
    if account_id is None:
        return None
    lowered = description.casefold()
    account_id = int(account_id)
    for rule in rules:
        if rule.account_id != account_id:
            continue
        if rule.match_text and not any(p in lowered for p in _phrases(rule.match_text)):
            continue
        if rule.amount_cents is not None and (amount_cents is None or abs(amount_cents) != abs(rule.amount_cents)):
            continue
        if rule.day_from and when.day < rule.day_from:
            continue
        if rule.day_to and when.day > rule.day_to:
            continue
        return rule
    return None


def match(
    rules: list[ImportRule], description: str, account_id: int | None, when: date, amount_cents: int | None = None
) -> int | None:
    """Return the category id of the first rule matching this row, or None."""
    rule = match_rule(rules, description, account_id, when, amount_cents)
    return rule.category_id if rule else None


def match_loan(
    rules: list[ImportRule],
    description: str,
    account_id: int | None,
    when: date,
    amount_cents: int | None,
    direction: str,
) -> ImportRule | None:
    """The first loan-payment rule matching a money-out row, or None."""
    if direction != "out":
        return None
    return match_rule([r for r in rules if r.loan_account_id is not None], description, account_id, when, amount_cents)