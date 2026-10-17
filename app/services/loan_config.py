"""User-editable loan types (personal / auto / mortgage / credit card / ...).

Stored in ``AppSetting`` as a compact ``key|label,key|label`` string so the list rides along with a
``config_io`` export. Unlike ``account_config`` this list is the user's to edit: it is seeded once
from ``DEFAULT_LOAN_TYPES`` and never overwritten after that.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models import AppSetting

LOAN_TYPES_KEY = "loan_types"

DEFAULT_LOAN_TYPES: tuple[tuple[str, str], ...] = (
    ("personal", "Personal loan"),
    ("auto", "Auto loan"),
    ("mortgage", "Mortgage"),
    ("student", "Student loan"),
    ("credit_card", "Credit card"),
    ("medical", "Medical"),
    ("business", "Business"),
    ("other", "Other"),
)


class LoanConfigError(ValueError):
    """A loan type list was invalid (shown to the user)."""


@dataclass(frozen=True)
class LoanType:
    key: str
    label: str


def _encode(types: list[LoanType] | tuple[tuple[str, str], ...]) -> str:
    parts = [t if isinstance(t, tuple) else (t.key, t.label) for t in types]
    return ",".join(f"{key}|{label}" for key, label in parts)


def _parse(raw: str) -> list[LoanType]:
    out: list[LoanType] = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            key, label = part.split("|")
            out.append(LoanType(key, label))
    return out


def ensure_loan_config(db: Session) -> None:
    """Seed the loan type list once; after that the user owns it."""
    if db.get(AppSetting, LOAN_TYPES_KEY) is None:
        db.add(AppSetting(key=LOAN_TYPES_KEY, value=_encode(DEFAULT_LOAN_TYPES)))
        db.commit()


def get_loan_types(db: Session) -> list[LoanType]:
    row = db.get(AppSetting, LOAN_TYPES_KEY)
    return _parse(row.value) if row else [LoanType(*t) for t in DEFAULT_LOAN_TYPES]


def loan_type_keys(db: Session) -> set[str]:
    return {t.key for t in get_loan_types(db)}


def set_loan_types(db: Session, types: list[LoanType]) -> list[LoanType]:
    if not types:
        raise LoanConfigError("Keep at least one loan type")
    cleaned: list[LoanType] = []
    seen: set[str] = set()
    for t in types:
        key, label = t.key.strip(), t.label.strip()
        if not key or not label:
            raise LoanConfigError("Every loan type needs a key and a name")
        if any(ch in key or ch in label for ch in ",|"):
            raise LoanConfigError("Loan type names cannot contain commas or pipes")
        if key in seen:
            raise LoanConfigError(f"Duplicate loan type {key!r}")
        seen.add(key)
        cleaned.append(LoanType(key, label))
    value = _encode(cleaned)
    row = db.get(AppSetting, LOAN_TYPES_KEY)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=LOAN_TYPES_KEY, value=value))
    db.commit()
    return cleaned
