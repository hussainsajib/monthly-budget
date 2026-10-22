"""Category metadata: the fixed set of types and the user-editable per-level names.

Both live in ``AppSetting`` as compact comma-separated strings so they travel with a
``config_io`` export and stay under that column's length limit. The type list is seeded
from ``DEFAULT_TYPES`` on first run and is not user-editable; level names are.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models import AppSetting

TYPES_KEY = "category_types"
LEVELS_KEY = "category_levels"

# "in" behaves like income (positive amount is money in, above budget is good); "out" like an expense.
DEFAULT_TYPES: tuple[tuple[str, str, str], ...] = (
    ("expense", "Expense", "out"),
    ("income", "Income", "in"),
    ("savings", "Savings", "out"),
    ("debt", "Debt", "out"),
    ("investment", "Investment", "out"),
)

DEFAULT_LEVELS: tuple[str, ...] = ("Section", "Category", "Sub-category", "Sub-sub-category")


class CategoryConfigError(ValueError):
    """A category configuration value was invalid (shown to the user)."""


@dataclass(frozen=True)
class CategoryType:
    key: str
    label: str
    direction: str  # "in" | "out"

    @property
    def is_income(self) -> bool:
        return self.direction == "in"


def _encode(types: tuple[tuple[str, str, str], ...]) -> str:
    return ",".join(f"{key}|{label}|{direction}" for key, label, direction in types)


def _parse(raw: str) -> list[CategoryType]:
    out: list[CategoryType] = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            key, label, direction = part.split("|")
            out.append(CategoryType(key, label, direction))
    return out


def ensure_category_config(db: Session) -> None:
    """Seed the fixed type list once; level names fall back to defaults until edited."""
    if db.get(AppSetting, TYPES_KEY) is None:
        db.add(AppSetting(key=TYPES_KEY, value=_encode(DEFAULT_TYPES)))
        db.commit()


def get_types(db: Session) -> list[CategoryType]:
    row = db.get(AppSetting, TYPES_KEY)
    return _parse(row.value) if row else [CategoryType(*t) for t in DEFAULT_TYPES]


def get_levels(db: Session) -> list[str]:
    row = db.get(AppSetting, LEVELS_KEY)
    return row.value.split(",") if row else list(DEFAULT_LEVELS)


def set_levels(db: Session, levels: list[str]) -> list[str]:
    if len(levels) != len(DEFAULT_LEVELS):
        raise CategoryConfigError(f"Expected {len(DEFAULT_LEVELS)} level names")
    cleaned = [name.strip() for name in levels]
    if not all(cleaned):
        raise CategoryConfigError("Every level needs a name")
    if any("," in name for name in levels):
        raise CategoryConfigError("Level names cannot contain commas")
    value = ",".join(cleaned)
    row = db.get(AppSetting, LEVELS_KEY)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=LEVELS_KEY, value=value))
    db.commit()
    return cleaned


def type_keys(db: Session) -> set[str]:
    return {t.key for t in get_types(db)}


def income_keys(db: Session) -> set[str]:
    return {t.key for t in get_types(db) if t.is_income}


def is_income(db: Session, key: str) -> bool:
    return any(t.is_income for t in get_types(db) if t.key == key)
