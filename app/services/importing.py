"""Bank / card CSV parsing, duplicate detection and commit."""

from __future__ import annotations

import csv
import hashlib
import io
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import to_cents
from app.models import Category, Transaction
from app.models.ledger import stored_amount
from app.services import import_rules, suggestions
from app.services.category_config import income_keys

DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d", "%d-%b-%Y", "%b %d, %Y", "%m/%d/%y")
DATE_HEADERS = ("date", "transaction date", "posted date", "posting date")
DESC_HEADERS = ("description", "payee", "merchant", "details", "memo", "name")
OUT_HEADERS = ("withdrawal", "withdrawals", "debit", "money out", "out", "paid out")
IN_HEADERS = ("deposit", "deposits", "credit", "money in", "in", "paid in")
AMOUNT_HEADERS = ("amount", "cad$", "amount (cad)")


class ImportError_(ValueError):
    """The file could not be understood."""


@dataclass
class ParsedRow:
    date: date
    description: str
    amount_cents: int  # always positive
    direction: str  # "out" or "in"
    category_id: int | None = None
    duplicate: bool = False
    key: str = ""
    recurring_template_id: int | None = None


def parse_date(text: str) -> date:
    text = text.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unrecognised date: {text!r}")


def _find(headers: list[str], candidates: tuple[str, ...]) -> int | None:
    for candidate in candidates:
        if candidate in headers:
            return headers.index(candidate)
    return None


def _looks_like_date(text: str) -> bool:
    try:
        parse_date(text)
        return True
    except ValueError:
        return False


def parse_csv(content: bytes, positive_is_expense: bool = True) -> list[ParsedRow]:
    """Parse a bank CSV with or without a header row.

    Headerless files are assumed to follow the TD layout: date, description,
    withdrawal, deposit[, balance].
    """
    text = content.decode("utf-8-sig", errors="replace")
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    if not rows:
        raise ImportError_("The file is empty")

    if _looks_like_date(rows[0][0]):
        date_i, desc_i, out_i, in_i, amt_i, data = 0, 1, 2, 3, None, rows
    else:
        headers = [h.strip().lower() for h in rows[0]]
        date_i = _find(headers, DATE_HEADERS)
        desc_i = _find(headers, DESC_HEADERS)
        out_i, in_i = _find(headers, OUT_HEADERS), _find(headers, IN_HEADERS)
        amt_i = _find(headers, AMOUNT_HEADERS)
        if date_i is None or desc_i is None or (amt_i is None and out_i is None and in_i is None):
            raise ImportError_(
                f"Could not find Date / Description / Amount columns. Headers seen: {', '.join(rows[0])}"
            )
        data = rows[1:]

    def cell(row: list[str], i: int | None) -> str:
        return row[i].strip() if i is not None and i < len(row) else ""

    parsed: list[ParsedRow] = []
    for line_no, row in enumerate(data, start=2):
        try:
            when = parse_date(cell(row, date_i))
            description = cell(row, desc_i)
            if amt_i is not None and cell(row, amt_i):
                signed = to_cents(cell(row, amt_i))
                is_out = (signed > 0) == positive_is_expense
                cents, direction = abs(signed), "out" if is_out else "in"
            elif cell(row, out_i):
                cents, direction = abs(to_cents(cell(row, out_i))), "out"
            elif cell(row, in_i):
                cents, direction = abs(to_cents(cell(row, in_i))), "in"
            else:
                continue
        except ValueError as exc:
            raise ImportError_(f"Row {line_no}: {exc}") from exc
        if cents:
            parsed.append(ParsedRow(when, description, cents, direction))
    return parsed


def row_key(row: ParsedRow, account_id: int | None, ordinal: int) -> str:
    raw = f"{row.date}|{row.description.lower()}|{row.amount_cents}|{row.direction}|{account_id}|{ordinal}"
    return hashlib.sha1(raw.encode()).hexdigest()


def assign_keys(rows: list[ParsedRow], account_id: int | None) -> None:
    """Hash each row; identical rows within a file get increasing ordinals."""
    seen: Counter[str] = Counter()
    for row in rows:
        base = f"{row.date}|{row.description.lower()}|{row.amount_cents}|{row.direction}"
        row.key = row_key(row, account_id, seen[base])
        seen[base] += 1


def prepare_preview(db: Session, rows: list[ParsedRow], account_id: int | None) -> list[ParsedRow]:
    """Fill suggested categories and flag rows that probably already exist."""
    assign_keys(rows, account_id)
    index = suggestions.build_index(db)
    known_hashes = set(
        db.scalars(select(Transaction.import_hash).where(Transaction.import_hash.in_([r.key for r in rows])))
    )
    existing = (
        {
            (t.date, abs(t.amount_cents), t.account_id)
            for t in db.scalars(select(Transaction).where(Transaction.account_id == account_id)).unique()
        }
        if rows
        else set()
    )
    rules = import_rules.active_rules(db)
    for row in rows:
        hit = suggestions.lookup(index, row.description)
        # Explicit rules only fill in where history (with its exact/fuzzy matching) has no answer.
        row.category_id = (
            hit.category_id
            if hit
            else import_rules.match(rules, row.description, account_id, row.date, row.amount_cents)
        )
        row.duplicate = row.key in known_hashes or (row.date, row.amount_cents, account_id) in existing
    return rows


def apply_rules(db: Session, rows: list[ParsedRow], account_id: int | None) -> None:
    """Fill categories a preview left blank, using history then the current rules.

    Rows that already carry a category (history, a rule that ran earlier, or the user's own pick)
    are left untouched, so applying a freshly added rule never overwrites a deliberate choice.
    """
    index = suggestions.build_index(db)
    rules = import_rules.active_rules(db)
    for row in rows:
        if row.category_id is not None:
            continue
        hit = suggestions.lookup(index, row.description)
        row.category_id = (
            hit.category_id
            if hit
            else import_rules.match(rules, row.description, account_id, row.date, row.amount_cents)
        )


def commit_rows(db: Session, rows: list[ParsedRow], account_id: int | None) -> int:
    kinds = {c.id: c.kind for c in db.scalars(select(Category))}
    income = income_keys(db)
    existing = set(
        db.scalars(select(Transaction.import_hash).where(Transaction.import_hash.in_([r.key for r in rows])))
    ) if rows else set()
    created = 0
    for row in rows:
        if row.key in existing:
            continue
        existing.add(row.key)
        created += 1
        kind = kinds[row.category_id]
        # One rule writes the row: money in on an expense (a refund) or money out on income is stored
        # negative; a transfer leg is stored as its signed effect. See ``ledger.stored_amount``.
        amount_cents = stored_amount(
            row.amount_cents, direction=row.direction, kind=kind, is_income=kind in income
        )
        db.add(
            Transaction(
                date=row.date,
                description=row.description[:200],
                category_id=row.category_id,
                account_id=account_id,
                amount_cents=amount_cents,
                import_hash=row.key,
                recurring_template_id=row.recurring_template_id,
            )
        )
    db.commit()
    return created
