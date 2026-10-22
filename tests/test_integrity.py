"""Ledger integrity: one sign rule shared by every balance, and a half-written pairing gets reported."""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from sqlalchemy import select

from app.models import REIMBURSEMENT, TRANSFER, Account, Transaction
from app.models.ledger import direction_effect, direction_of, signed_delta, stored_amount
from app.services import reimbursements as reimbursement_service
from app.services import transfers as transfer_service
from app.services.balances import balance_deltas
from app.services.cashflow import balance_at, balance_on, build_ledger, running_deltas
from app.services.category_config import income_keys
from app.services.integrity import validate_ledger

WHEN = date(2026, 5, 4)


def _add(db, *, category_id, account_id, amount_cents, link_id=None, link_kind=None):
    txn = Transaction(
        date=WHEN,
        description="Row",
        category_id=category_id,
        account_id=account_id,
        amount_cents=amount_cents,
        notes=None,
        link_id=link_id,
        link_kind=link_kind,
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
    _add(
        db,
        category_id=transfer_cat,
        account_id=accs["Chequing"],
        amount_cents=-25000,
        link_id="t-1",
        link_kind=TRANSFER,
    )
    _add(
        db, category_id=transfer_cat, account_id=accs["Savings"], amount_cents=25000, link_id="t-1", link_kind=TRANSFER
    )
    outlay = _add(db, category_id=reimb, account_id=accs["Chequing"], amount_cents=4000)
    repayment = _add(db, category_id=reimb, account_id=accs["Savings"], amount_cents=-4000)
    reimbursement_service.connect(db, outlay, repayment)

    assert _python_balances(db) == balance_deltas(db)


def test_writing_a_row_and_reading_it_back_are_inverse():
    """``stored_amount`` (writer) is the exact inverse of ``signed_delta`` (reader), for every kind."""
    for kind in ("expense", "income", "transfer", "savings", "debt"):
        for is_income in (True, False):
            for direction in ("in", "out"):
                stored = stored_amount(1000, direction=direction, kind=kind, is_income=is_income)
                effect = direction_effect(1000, direction)
                assert signed_delta(stored, kind=kind, is_income=is_income) == effect
                assert direction_of(effect) == direction


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


def test_every_balance_view_reads_the_same_walk(db, ids):
    cats, accs = ids
    cheque = db.get(Account, accs["Chequing"])
    savings = db.get(Account, accs["Savings"])
    cheque.opening_balance_cents, cheque.opening_date = 100000, date(2026, 5, 1)
    db.commit()
    try:
        _add(db, category_id=cats["Grocery"], account_id=cheque.id, amount_cents=30000)
        _add(db, category_id=cats["Salary (net)"], account_id=cheque.id, amount_cents=50000)
        _add(db, category_id=cats["Rent"], account_id=savings.id, amount_cents=20000)

        ledger = build_ledger(db, cheque)
        assert balance_at(db, cheque, date(2026, 5, 3)) == 100000
        assert balance_at(db, cheque, WHEN) == ledger.rows[-1].balance_cents == 120000

        timelines = running_deltas(db, [cheque, savings])
        assert balance_on(timelines[cheque.id], WHEN) == 20000
        assert balance_on(timelines[savings.id], WHEN) == -20000
        assert balance_deltas(db, {cheque.id})[cheque.id] == balance_on(timelines[cheque.id], WHEN)
    finally:
        cheque.opening_balance_cents, cheque.opening_date = 0, None
        db.commit()


def test_opening_date_bounds_every_balance(db, ids):
    cats, accs = ids
    cheque = db.get(Account, accs["Chequing"])
    cheque.opening_balance_cents, cheque.opening_date = 100000, date(2026, 5, 5)
    db.commit()
    try:
        _add(db, category_id=cats["Grocery"], account_id=cheque.id, amount_cents=30000)

        assert balance_deltas(db, {cheque.id}) == {}
        assert balance_at(db, cheque, WHEN) == 100000
        assert build_ledger(db, cheque).current_balance_cents == 100000
        assert running_deltas(db, [cheque])[cheque.id] == []
    finally:
        cheque.opening_balance_cents, cheque.opening_date = 0, None
        db.commit()


def test_a_clean_ledger_reports_no_problems(db, ids):
    cats, accs = ids
    transfer_cat = transfer_service.ensure_transfer_section(db).id
    reimb = reimbursement_service.ensure_reimbursement_category(db).id
    _add(db, category_id=cats["Grocery"], account_id=accs["Chequing"], amount_cents=3000)
    _add(
        db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=-1000, link_id="t-1", link_kind=TRANSFER
    )
    _add(db, category_id=transfer_cat, account_id=accs["Savings"], amount_cents=1000, link_id="t-1", link_kind=TRANSFER)
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
    _add(
        db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=-1000, link_id="t-1", link_kind=TRANSFER
    )

    report = validate_ledger(db)
    assert report["ok"] is False
    assert "transfer_legs" in _codes(report)
    assert report["scanned"]["transfers"] == 1
    assert report["issues"][0]["count"] == 1


def test_reports_a_transfer_that_never_left_the_account(db, ids):
    _, accs = ids
    transfer_cat = transfer_service.ensure_transfer_section(db).id
    _add(
        db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=-1000, link_id="t-1", link_kind=TRANSFER
    )
    _add(
        db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=1000, link_id="t-1", link_kind=TRANSFER
    )

    assert "transfer_accounts" in _codes(validate_ledger(db))


def test_reports_a_transfer_leg_that_lost_its_category(db, ids):
    cats, accs = ids
    transfer_cat = transfer_service.ensure_transfer_section(db).id
    _add(
        db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=-1000, link_id="t-1", link_kind=TRANSFER
    )
    _add(
        db,
        category_id=cats["Grocery"],
        account_id=accs["Savings"],
        amount_cents=1000,
        link_id="t-1",
        link_kind=TRANSFER,
    )

    assert "transfer_category" in _codes(validate_ledger(db))


def test_reports_a_reimbursement_whose_amounts_do_not_match(db, ids):
    _, accs = ids
    reimb = reimbursement_service.ensure_reimbursement_category(db).id
    _add(db, category_id=reimb, account_id=accs["Chequing"], amount_cents=5000, link_id="r-1", link_kind=REIMBURSEMENT)
    _add(db, category_id=reimb, account_id=accs["Savings"], amount_cents=-4000, link_id="r-1", link_kind=REIMBURSEMENT)

    assert "pair_signs" in _codes(validate_ledger(db))


def test_reports_a_reimbursement_missing_a_leg(db, ids):
    _, accs = ids
    reimb = reimbursement_service.ensure_reimbursement_category(db).id
    _add(db, category_id=reimb, account_id=accs["Chequing"], amount_cents=4000, link_id="r-1", link_kind=REIMBURSEMENT)

    assert "reimbursement_legs" in _codes(validate_ledger(db))


def test_reports_a_paired_row_with_no_link_kind(db, ids):
    _, accs = ids
    transfer_cat = transfer_service.ensure_transfer_section(db).id
    _add(db, category_id=transfer_cat, account_id=accs["Chequing"], amount_cents=-1000, link_id="t-1")

    assert "link_kind" in _codes(validate_ledger(db))


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
