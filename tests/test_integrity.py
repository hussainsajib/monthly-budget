"""Ledger integrity: one sign rule shared by every balance, and a half-written pairing gets reported."""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from sqlalchemy import select

from app.models import Account, Transaction
from app.services import reimbursements as reimbursement_service
from app.services import transfers as transfer_service
from app.services.balances import balance_deltas
from app.services.cashflow import build_ledger
from app.services.category_config import income_keys
from app.services.integrity import validate_ledger

WHEN = date(2026, 5, 4)


def _add(db, *, category_id, account_id, amount_cents, transfer_id=None, reimbursement_id=None):
    txn = Transaction(
        date=WHEN,
        description="Row",
        category_id=category_id,
        account_id=account_id,
        amount_cents=amount_cents,
        notes=None,
        transfer_id=transfer_id,
        reimbursement_id=reimbursement_id,
    )
    db.add(txn)
    db.commit()
    return txn


def _python_balances(db) -> dict[int, int]:
    """Per-account totals using the Python rule rows carry, not the SQL expression."""
    income = income_keys(db)
    totals: dict[int, int] = defaultdict(int)
    for txn in db.scalars(select(Transaction)):
        if txn.account_id is not None:
            totals[txn.account_id] += txn.cash_delta_cents(txn.category.kind in income)
    return dict(totals)


def _codes(report) -> set[str]:
    return {issue["code"] for issue in report["issues"]}


def test_the_python_rule_and_the_sql_expression_agree(db, ids):
    cats, accs = ids
    transfer_cat = transfer_service.ensure_transfer_section(db).id
    reimb = reimbursement_service.ensure_reimbursement_category(db).id

    _add(db, category_id=cats["Grocery"], account_id=accs["Chequing"], amount_cents=3000)
    _add(db, category_id=cats["Other Income"], account_id=accs["Chequing"], amount_cents=50000)
    _add(db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=-25000, transfer_id="t-1")
    _add(db, category_id=transfer_cat, account_id=accs["Savings"], amount_cents=25000, transfer_id="t-1")
    outlay = _add(db, category_id=reimb, account_id=accs["Chequing"], amount_cents=4000)
    repayment = _add(db, category_id=reimb, account_id=accs["Savings"], amount_cents=-4000)
    reimbursement_service.connect(db, outlay, repayment)

    assert _python_balances(db) == balance_deltas(db)


def test_pairing_a_reimbursement_keeps_its_cash_effect(db, ids):
    _, accs = ids
    reimb = reimbursement_service.ensure_reimbursement_category(db).id
    outlay = _add(db, category_id=reimb, account_id=accs["Chequing"], amount_cents=4000)
    repayment = _add(db, category_id=reimb, account_id=accs["Savings"], amount_cents=-4000)

    before = _python_balances(db)
    reimbursement_service.connect(db, outlay, repayment)
    after = _python_balances(db)

    assert after == before
    assert after[accs["Chequing"]] == -4000
    assert after[accs["Savings"]] == 4000


def test_the_ledger_running_balance_uses_the_same_rule(db, ids):
    _, accs = ids
    reimb = reimbursement_service.ensure_reimbursement_category(db).id
    outlay = _add(db, category_id=reimb, account_id=accs["Chequing"], amount_cents=4000)
    repayment = _add(db, category_id=reimb, account_id=accs["Savings"], amount_cents=-4000)
    reimbursement_service.connect(db, outlay, repayment)

    ledger = build_ledger(db, db.get(Account, accs["Chequing"]))
    assert ledger.current_balance_cents == -4000


def test_a_clean_ledger_reports_no_problems(db, ids):
    cats, accs = ids
    transfer_cat = transfer_service.ensure_transfer_section(db).id
    reimb = reimbursement_service.ensure_reimbursement_category(db).id
    _add(db, category_id=cats["Grocery"], account_id=accs["Chequing"], amount_cents=3000)
    _add(db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=-1000, transfer_id="t-1")
    _add(db, category_id=transfer_cat, account_id=accs["Savings"], amount_cents=1000, transfer_id="t-1")
    outlay = _add(db, category_id=reimb, account_id=accs["Chequing"], amount_cents=4000)
    repayment = _add(db, category_id=reimb, account_id=accs["Savings"], amount_cents=-4000)
    reimbursement_service.connect(db, outlay, repayment)

    report = validate_ledger(db)
    assert report["ok"] is True
    assert report["issues"] == []
    assert report["scanned"] == {"transactions": 5, "transfers": 1, "reimbursements": 1}


def test_reports_a_transfer_missing_a_leg(db, ids):
    _, accs = ids
    transfer_cat = transfer_service.ensure_transfer_section(db).id
    _add(db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=-1000, transfer_id="t-1")

    report = validate_ledger(db)
    assert report["ok"] is False
    assert "transfer_legs" in _codes(report)
    assert report["scanned"]["transfers"] == 1
    assert report["issues"][0]["count"] == 1


def test_reports_a_transfer_that_never_left_the_account(db, ids):
    _, accs = ids
    transfer_cat = transfer_service.ensure_transfer_section(db).id
    _add(db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=-1000, transfer_id="t-1")
    _add(db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=1000, transfer_id="t-1")

    assert "transfer_accounts" in _codes(validate_ledger(db))


def test_reports_a_transfer_leg_that_lost_its_category(db, ids):
    cats, accs = ids
    transfer_cat = transfer_service.ensure_transfer_section(db).id
    _add(db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=-1000, transfer_id="t-1")
    _add(db, category_id=cats["Grocery"], account_id=accs["Savings"], amount_cents=1000, transfer_id="t-1")

    assert "transfer_category" in _codes(validate_ledger(db))


def test_reports_a_reimbursement_whose_amounts_do_not_match(db, ids):
    _, accs = ids
    reimb = reimbursement_service.ensure_reimbursement_category(db).id
    _add(db, category_id=reimb, account_id=accs["Chequing"], amount_cents=5000, reimbursement_id="r-1")
    _add(db, category_id=reimb, account_id=accs["Savings"], amount_cents=-4000, reimbursement_id="r-1")

    assert "pair_signs" in _codes(validate_ledger(db))


def test_reports_a_reimbursement_missing_a_leg(db, ids):
    _, accs = ids
    reimb = reimbursement_service.ensure_reimbursement_category(db).id
    _add(db, category_id=reimb, account_id=accs["Chequing"], amount_cents=4000, reimbursement_id="r-1")

    assert "reimbursement_legs" in _codes(validate_ledger(db))


def test_reports_a_row_that_is_both_a_transfer_and_a_reimbursement(db, ids):
    _, accs = ids
    transfer_cat = transfer_service.ensure_transfer_section(db).id
    _add(
        db,
        category_id=transfer_cat,
        account_id=accs["Chequing"],
        amount_cents=-1000,
        transfer_id="t-1",
        reimbursement_id="r-1",
    )

    assert "double_linked" in _codes(validate_ledger(db))


def test_the_check_endpoint_returns_a_report(client, ids):
    _, accs = ids
    client.post(
        "/api/transfers",
        json={
            "date": "2026-05-04",
            "description": "To savings",
            "amount": "250",
            "from_account_id": accs["Chequing"],
            "to_account_id": accs["Savings"],
            "notes": "",
        },
    )

    res = client.get("/api/ledger/check")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["issues"] == []
    assert body["scanned"]["transfers"] == 1
