"""Export/import of the personal setup. Uses a throw-away database so the shared test DB keeps its seed."""

from __future__ import annotations

import json
import tempfile
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Account, Category, MonthlyBudget, RecurringTemplate, Transaction
from app.services.config_io import ConfigError, export_config, import_config

SETUP = {
    "version": 1,
    "categories": [
        {"path": ["Home"], "kind": "expense", "sort_order": 10},
        {"path": ["Home", "Rent"], "kind": "expense", "monthly_budget_cents": 100000, "sort_order": 10},
        {"path": ["Home", "Old thing"], "kind": "expense", "sort_order": 20, "is_active": False},
        {"path": ["Pay"], "kind": "income", "sort_order": 20},
        {"path": ["Pay", "Salary"], "kind": "income", "monthly_budget_cents": 300000},
    ],
    "accounts": [
        {"name": "Main", "kind": "bank", "opening_balance_cents": 5000, "opening_date": "2026-01-01"},
        {
            "name": "Card",
            "kind": "debt",
            "is_active": False,
            "loan": {
                "loan_type": "credit_card",
                "lender": "Bank",
                "original_principal_cents": 0,
                "rate_bps": 1999,
                "is_interest_bearing": True,
                "min_payment_cents": 2500,
                "due_day": 15,
                "credit_limit_cents": 500000,
                "reference": "ends 4242",
                "notes": "",
            },
        },
    ],
    "recurring": [
        {
            "description": "Rent",
            "category": ["Home", "Rent"],
            "account": "Main",
            "amount_cents": 100000,
            "day_of_month": 1,
        }
    ],
    "monthly_budgets": [{"month": "2026-06", "category": ["Home", "Rent"], "amount_cents": 110000}],
    "settings": {"low_balance_cents": "1234"},
}


@pytest.fixture
def scratch():
    path = Path(tempfile.mkdtemp()) / "scratch.db"
    engine = create_engine(f"sqlite:///{path.as_posix()}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def test_roundtrip_reproduces_the_setup_exactly(scratch):
    counts = import_config(scratch, SETUP)
    expected = {"categories": 5, "accounts": 2, "recurring": 1, "monthly_budgets": 1, "import_rules": 0, "settings": 1}
    assert counts == expected

    exported = export_config(scratch)
    assert [c["path"] for c in exported["categories"]] == [c["path"] for c in SETUP["categories"]]
    assert exported["recurring"][0]["account"] == "Main"
    assert exported["monthly_budgets"] == [
        {"month": "2026-06", "category": ["Home", "Rent"], "amount_cents": 110000}
    ]
    assert exported["accounts"][0]["opening_date"] == "2026-01-01"
    assert exported["accounts"][1]["is_active"] is False

    # the file is JSON-safe, and loading its own output into a fresh database gives the same export again
    again = json.loads(json.dumps(exported))
    with Session(scratch.get_bind()) as other:
        import_config(other, again, replace=True)
        assert export_config(other) == exported


def test_merge_is_idempotent_and_keeps_extra_rows(scratch):
    import_config(scratch, SETUP)
    scratch.add(Category(name="Keep me", kind="expense"))
    scratch.commit()

    import_config(scratch, SETUP)  # second run: updates in place, creates nothing
    assert scratch.query(Category).count() == 6
    assert scratch.query(Account).count() == 2
    assert scratch.query(RecurringTemplate).count() == 1
    assert scratch.query(MonthlyBudget).count() == 1

    changed = json.loads(json.dumps(SETUP))
    changed["categories"][1]["monthly_budget_cents"] = 120000
    import_config(scratch, changed)
    rent = scratch.scalar(select(Category).where(Category.name == "Rent"))
    assert rent.monthly_budget_cents == 120000


def test_replace_wipes_the_old_setup(scratch):
    import_config(scratch, SETUP)
    scratch.add(Category(name="Sample", kind="expense"))
    scratch.commit()
    import_config(scratch, SETUP, replace=True)
    assert {c.name for c in scratch.scalars(select(Category))} == {"Home", "Rent", "Old thing", "Pay", "Salary"}


def test_replace_is_refused_when_transactions_exist_and_changes_nothing(scratch):
    import_config(scratch, SETUP)
    rent = scratch.scalar(select(Category).where(Category.name == "Rent"))
    scratch.add(Transaction(date=date(2026, 6, 1), description="x", category_id=rent.id, amount_cents=100))
    scratch.commit()
    with pytest.raises(ConfigError, match="transactions"):
        import_config(scratch, SETUP, replace=True)
    assert scratch.query(Category).count() == 5 and scratch.query(Transaction).count() == 1


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda d: d.update(version=99), "version"),
        (lambda d: d["categories"].insert(0, {"path": ["Orphan", "Child"], "kind": "expense"}), "parent"),
        (lambda d: d["categories"].append({"path": ["X"], "kind": "weird"}), "kind"),
        (lambda d: d["recurring"][0].update(category=["Nope"]), "unknown category"),
        (lambda d: d["recurring"][0].update(account="Ghost"), "unknown account"),
        (lambda d: d["categories"].append({"path": ["a", "b", "c", "d", "e"], "kind": "expense"}), "levels"),
    ],
)
def test_bad_files_are_rejected_without_partial_changes(scratch, mutate, message):
    data = json.loads(json.dumps(SETUP))
    mutate(data)
    with pytest.raises(ConfigError, match=message):
        import_config(scratch, data)
    assert scratch.query(Category).count() == 0 and scratch.query(Account).count() == 0


def test_export_of_the_seeded_database_is_complete(db):
    data = export_config(db)
    paths = [tuple(c["path"]) for c in data["categories"]]
    assert ("Fixed Expenses",) in paths and ("Fixed Expenses", "Rent") in paths
    assert paths.index(("Fixed Expenses",)) < paths.index(("Fixed Expenses", "Rent"))  # parents first
    assert {a["name"] for a in data["accounts"]} >= {"Chequing", "Credit Card"}
    assert all(isinstance(r["category"], list) for r in data["recurring"])
