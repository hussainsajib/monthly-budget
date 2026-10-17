"""Configurable account types (bank / cash / savings / investment / debt by default).

Stored compactly in ``AppSetting`` so they ride along with ``config_io`` exports and stay
under that column's length limit. The list is seeded from ``DEFAULT_ACCOUNT_TYPES`` on
first run and is not user-editable; it drives the account type picker and labels.

Credit cards are not a separate type: a card is ``debt`` with a ``credit_card`` loan type
(see ``app.services.loan_config``).
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models import AppSetting

ACCOUNT_TYPES_KEY = "account_types"

DEFAULT_ACCOUNT_TYPES: tuple[tuple[str, str], ...] = (
    ("bank", "Bank / Chequing"),
    ("cash", "Cash"),
    ("savings", "Savings"),
    ("investment", "Investment"),
    ("debt", "Debt / loan"),
)


@dataclass(frozen=True)
class AccountType:
    key: str
    label: str


def _encode(types: tuple[tuple[str, str], ...]) -> str:
    return ",".join(f"{key}|{label}" for key, label in types)


def _parse(raw: str) -> list[AccountType]:
    out: list[AccountType] = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            key, label = part.split("|")
            out.append(AccountType(key, label))
    return out


def ensure_account_config(db: Session) -> None:
    """Seed the fixed account type list, migrating any earlier (pre-config) seed to the current set."""
    target = _encode(DEFAULT_ACCOUNT_TYPES)
    row = db.get(AppSetting, ACCOUNT_TYPES_KEY)
    if row is None:
        db.add(AppSetting(key=ACCOUNT_TYPES_KEY, value=target))
        db.commit()
    elif row.value != target:
        row.value = target
        db.commit()


def get_account_types(db: Session) -> list[AccountType]:
    row = db.get(AppSetting, ACCOUNT_TYPES_KEY)
    return _parse(row.value) if row else [AccountType(*t) for t in DEFAULT_ACCOUNT_TYPES]


def account_type_keys(db: Session) -> set[str]:
    return {t.key for t in get_account_types(db)}