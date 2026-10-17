"""Loans: a debt account plus its loan metadata, with the balance still derived from transactions."""

from __future__ import annotations

from datetime import date

import pytest

from app.models import Account, LoanDetails

BASE = {
    "name": "Test Car Loan",
    "owed": "25000",
    "opening_date": "2026-01-01",
    "details": {"loan_type": "auto", "lender": "Big Bank", "original_principal": "25000", "rate": "6.49"},
}


@pytest.fixture
def make_loan(client):
    created: list[int] = []

    def _make(**overrides):
        body = {**BASE, **overrides}
        res = client.post("/api/loans", json=body)
        assert res.status_code == 201, res.text
        created.append(res.json()["account_id"])
        return res.json()["account_id"]

    yield _make
    for account_id in created:
        client.delete(f"/api/loans/{account_id}")


def _loan(client, account_id):
    res = client.get(f"/api/loans/{account_id}")
    assert res.status_code == 200, res.text
    return res.json()


def test_creating_a_loan_stores_owed_as_a_signed_balance(client, make_loan):
    account_id = make_loan()
    loan = _loan(client, account_id)
    assert loan["owed_cents"] == 2_500_000
    assert loan["balance_cents"] == -2_500_000  # ledger convention: negative means you owe
    assert loan["is_active"] is True
    assert loan["rate_bps"] == 649 and loan["rate_pct"] == 6.49
    assert loan["loan_type"] == "auto" and loan["loan_type_label"] == "Auto loan"
    assert loan["lender"] == "Big Bank"
    assert loan["payoff_pct"] == 0.0


def test_accounts_list_reads_a_loan_as_amount_owed(client, make_loan):
    account_id = make_loan()
    rows = {r["id"]: r for r in client.get("/api/accounts").json()}
    row = rows[account_id]
    assert row["is_loan"] is True
    assert row["current_balance_cents"] == -2_500_000
    assert row["owed_cents"] == 2_500_000
    assert row["loan_type"] == "auto"


def test_accounts_api_takes_a_debt_opening_balance_as_owed(client):
    body = {"name": "Legacy Card", "kind": "debt", "opening_balance": "920", "opening_date": "2026-01-01"}
    res = client.post("/api/accounts", json=body)
    assert res.status_code == 201, res.text
    account_id = res.json()["id"]
    try:
        # The form is owed-faced, so the signed balance the ledger keeps is its inverse - and stays put on edit.
        assert res.json()["opening_balance_cents"] == -92_000
        assert res.json()["owed_cents"] == 92_000
        assert client.put(f"/api/accounts/{account_id}", json=body).json()["opening_balance_cents"] == -92_000
    finally:
        client.delete(f"/api/accounts/{account_id}")


def test_recording_a_payment_lowers_owed_and_writes_both_legs(client, ids, make_loan):
    _, accs = ids
    account_id = make_loan()
    chequing = accs["Chequing"]
    before = {r["id"]: r for r in client.get("/api/accounts").json()}[chequing]

    res = client.post(
        f"/api/loans/{account_id}/payments",
        json={"from_account_id": chequing, "amount": "2000", "date": "2026-02-01"},
    )
    assert res.status_code == 201, res.text
    transfer_id = res.json()["transfer_id"]

    after = {r["id"]: r for r in client.get("/api/accounts").json()}
    assert _loan(client, account_id)["owed_cents"] == 2_300_000
    assert after[chequing]["current_balance_cents"] == before["current_balance_cents"] - 200_000

    legs = [t for t in client.get("/api/transactions", params={"account_id": account_id}).json()["items"]]
    assert all(t["transfer_id"] == transfer_id for t in legs)
    assert len(legs) == 1 and legs[0]["amount_cents"] == 200_000


def test_a_card_purchase_raises_owed(client, ids):
    _, accs = ids
    card = accs["Credit Card"]  # the starter config ships this as a debt/loan account
    cats, _ = ids
    before = _loan(client, card)["owed_cents"]
    res = client.post(
        "/api/transactions",
        json={
            "date": "2026-05-04",
            "description": "Groceries",
            "category_id": cats["Dining Out / Takeout"],
            "account_id": card,
            "amount": "42.00",
            "notes": "",
        },
    )
    assert res.status_code == 201, res.text
    assert _loan(client, card)["owed_cents"] == before + 4_200


def test_totals_group_by_loan_type(client, make_loan):
    make_loan(name="Auto Loan", details={"loan_type": "auto"})
    make_loan(name="Studio Loan", details={"loan_type": "personal"})
    data = client.get("/api/loans").json()
    assert data["totals"]["owed_cents"] == 5_000_000
    by_type = {t["key"]: t for t in data["totals"]["by_type"]}
    assert by_type["auto"]["owed_cents"] == 2_500_000 and by_type["auto"]["label"] == "Auto loan"
    assert by_type["auto"]["count"] == 1 and by_type["personal"]["count"] == 1


def test_residual_is_carried_and_reported_separately(client, ids, make_loan):
    _, accs = ids
    account_id = make_loan(
        name="Leased Car",
        owed="25800",
        details={"loan_type": "auto", "original_principal": "25800", "residual": "15000"},
    )
    loan = _loan(client, account_id)
    assert loan["owed_cents"] == 2_580_000
    assert loan["residual_cents"] == 1_500_000
    assert loan["amortizing_owed_cents"] == 1_080_000

    client.post(
        f"/api/loans/{account_id}/payments",
        json={"from_account_id": accs["Chequing"], "amount": "450", "date": "2026-02-01"},
    )
    loan = _loan(client, account_id)
    assert loan["owed_cents"] == 2_535_000
    assert loan["amortizing_owed_cents"] == 1_035_000
    assert loan["payoff_pct"] < 10.0

    data = client.get("/api/loans").json()
    row = next(r for r in data["items"] if r["account_id"] == account_id)
    assert row["residual_cents"] == 1_500_000
    assert data["totals"]["residual_cents"] >= 1_500_000


def test_residual_cannot_exceed_or_be_negative(client):
    assert client.post("/api/loans", json={**BASE, "details": {"residual": "999999"}}).status_code == 400
    assert client.post("/api/loans", json={**BASE, "details": {"residual": "-1"}}).status_code == 400


def test_disbursement_lands_in_destination_without_double_counting(client, ids, make_loan):
    _, accs = ids
    chequing = accs["Chequing"]
    before = {r["id"]: r for r in client.get("/api/accounts").json()}[chequing]["current_balance_cents"]
    account_id = make_loan(
        name="Cash Loan",
        owed="5000",
        details={"loan_type": "personal"},
        disbursement_account_id=chequing,
        disbursement_amount="5000",
        disbursement_date="2026-01-02",
    )
    after = {r["id"]: r for r in client.get("/api/accounts").json()}
    assert _loan(client, account_id)["owed_cents"] == 500_000  # still 5,000 owed, not 10,000
    assert after[chequing]["current_balance_cents"] == before + 500_000


def test_updating_a_loan_changes_owed_and_metadata(client, make_loan):
    account_id = make_loan()
    res = client.put(
        f"/api/loans/{account_id}",
        json={
            "name": "Renamed Loan",
            "owed": "20000",
            "opening_date": "2026-01-01",
            "is_active": True,
            "details": {
                "loan_type": "personal",
                "lender": "Credit Union",
                "rate": "4",
                "min_payment": "300",
                "due_day": 5,
            },
        },
    )
    assert res.status_code == 200, res.text
    loan = _loan(client, account_id)
    assert loan["name"] == "Renamed Loan"
    assert loan["owed_cents"] == 2_000_000
    assert loan["loan_type"] == "personal" and loan["lender"] == "Credit Union"
    assert loan["rate_bps"] == 400 and loan["min_payment_cents"] == 30_000 and loan["due_day"] == 5
    assert loan["next_due_date"] is not None


def test_rejects_bad_input(client, make_loan):
    assert client.post("/api/loans", json={"name": "", "owed": "1"}).status_code == 400
    assert client.post("/api/loans", json={"name": "Neg", "owed": "-5"}).status_code == 400
    assert client.post("/api/loans", json={**BASE, "details": {"loan_type": "nope"}}).status_code == 400
    assert client.post("/api/loans", json={**BASE, "details": {"due_day": 40}}).status_code == 400
    account_id = make_loan()
    assert client.post(f"/api/loans/{account_id}", json={"name": "x"}).status_code == 405
    no_payer = client.post(
        f"/api/loans/{account_id}/payments", json={"amount": "5", "date": "2026-02-01"}
    )
    assert no_payer.status_code == 400
    assert client.get("/api/loans/999999").status_code == 404


def test_deleting_a_loan_removes_its_details(client, db, make_loan):
    account_id = make_loan()
    assert db.get(LoanDetails, account_id) is not None
    assert client.delete(f"/api/loans/{account_id}").status_code == 204
    db.expire_all()
    assert db.get(Account, account_id) is None
    assert db.get(LoanDetails, account_id) is None


def test_changing_an_account_away_from_debt_drops_loan_details(client, db, make_loan):
    account_id = make_loan()
    res = client.put(
        f"/api/accounts/{account_id}",
        json={"name": "Now A Bank", "kind": "bank", "opening_balance": "0", "opening_date": None, "is_active": True},
    )
    assert res.status_code == 200, res.text
    db.expire_all()
    assert db.get(LoanDetails, account_id) is None
    assert client.get(f"/api/loans/{account_id}").status_code == 404


def test_debt_accounts_without_details_are_reported_once(client, db):
    account = Account(name="Legacy Debt", kind="debt", opening_balance_cents=-123_400)
    db.add(account)
    db.commit()
    try:
        data = client.get("/api/loans").json()
        assert {"account_id": account.id, "name": "Legacy Debt"} in data["missing_details"]
        row = next(r for r in data["items"] if r["account_id"] == account.id)
        assert row["has_details"] is False and row["owed_cents"] == 123_400
    finally:
        db.delete(account)
        db.commit()


def test_a_money_out_row_becomes_a_loan_payment(client, ids, make_loan):
    cats, accs = ids
    account_id = make_loan()
    chequing = accs["Chequing"]
    created = client.post(
        "/api/transactions",
        json={
            "date": "2026-03-01",
            "description": "Lease payment",
            "category_id": cats["Dining Out / Takeout"],
            "account_id": chequing,
            "amount": "450",
            "notes": "car lease",
        },
    )
    assert created.status_code == 201, created.text
    txn_id = created.json()["id"]
    owed_before = _loan(client, account_id)["owed_cents"]

    res = client.post(
        f"/api/loans/{account_id}/payments/from-transaction", json={"txn_id": txn_id}
    )
    assert res.status_code == 201, res.text
    transfer_id = res.json()["transfer_id"]

    # Two legs share the transfer, and the loan balance dropped by the payment.
    assert _loan(client, account_id)["owed_cents"] == owed_before - 45_000
    on_loan = client.get("/api/transactions", params={"account_id": account_id}).json()["items"]
    assert len(on_loan) == 1 and on_loan[0]["transfer_id"] == transfer_id
    out_leg = client.get("/api/transactions", params={"account_id": chequing}).json()["items"][0]
    assert out_leg["id"] == txn_id  # the imported row itself becomes the outgoing leg
    assert out_leg["transfer_id"] == transfer_id
    assert out_leg["kind"] == "transfer"
    assert out_leg["amount_cents"] == -45_000
    assert out_leg["notes"] == "car lease"
    transfers = client.get(f"/api/transfers/{transfer_id}").json()
    assert transfers["amount_cents"] == 45_000 and transfers["to_account_id"] == account_id


def test_only_a_money_out_row_can_become_a_payment(client, ids, make_loan):
    cats, accs = ids
    account_id = make_loan()
    chequing = accs["Chequing"]
    # A refund: a negative amount on an expense category reads as money *in*.
    money_in = client.post(
        "/api/transactions",
        json={
            "date": "2026-03-01",
            "description": "Refund",
            "category_id": cats["Dining Out / Takeout"],
            "account_id": chequing,
            "amount": "-450",
        },
    ).json()["id"]
    res = client.post(f"/api/loans/{account_id}/payments/from-transaction", json={"txn_id": money_in})
    assert res.status_code == 400

    # A row already part of a transfer is refused too.
    client.post(
        "/api/transfers",
        json={
            "date": "2026-03-02",
            "description": "Move",
            "amount": "100",
            "from_account_id": chequing,
            "to_account_id": accs["Savings"],
            "notes": "",
        },
    )
    leg = next(
        t
        for t in client.get("/api/transactions", params={"account_id": chequing}).json()["items"]
        if t["transfer_id"] is not None
    )
    assert (
        client.post(
            f"/api/loans/{account_id}/payments/from-transaction", json={"txn_id": leg["id"]}
        ).status_code
        == 400
    )
    assert client.post(
        f"/api/loans/{account_id}/payments/from-transaction", json={"txn_id": 999999}
    ).status_code == 404


def test_a_recurring_item_can_schedule_a_loan_payment(client, ids, make_loan):
    cats, accs = ids
    loan_id = make_loan(name="Lease", owed="25800")
    chequing = accs["Chequing"]
    body = {
        "description": "Lease payment",
        "account_id": chequing,
        "loan_account_id": loan_id,
        "amount": "450",
        "day_of_month": 15,
        "schedule": {"freq": "monthly", "interval": 1, "start": "2026-01-15", "by_month_day": [15]},
    }
    res = client.post("/api/recurring", json=body)
    assert res.status_code == 201, res.text
    tpl_id = res.json()["id"]
    try:
        row = next(t for t in client.get("/api/recurring").json() if t["id"] == tpl_id)
        assert row["loan_account_id"] == loan_id and row["loan_name"] == "Lease"
        assert row["account_id"] == chequing
        assert row["category_path"] == "Transfer \u203a Between accounts"  # a payment is a transfer
        assert row["is_income"] is False

        # The loan surfaces the next payment, ready to pre-fill the Record payment form.
        schedule = _loan(client, loan_id)["schedule"]
        assert schedule["amount_cents"] == 45_000
        assert schedule["from_account_id"] == chequing
        assert schedule["recurring_template_id"] == tpl_id
        assert schedule["date"] >= date.today().isoformat()

        # It is a transfer, so it never shows up as a budget commitment.
        month = date.today().strftime("%Y-%m")
        lines = client.get("/api/budget", params={"month": month}).json()["lines"]
        transfer_lines = [ln for ln in lines if ln["kind"] == "transfer"]
        assert all(ln["recurring_cents"] == 0 for ln in transfer_lines)
    finally:
        client.delete(f"/api/recurring/{tpl_id}")


def test_a_loan_payment_recurring_item_needs_a_real_loan(client, ids, make_loan):
    _, accs = ids
    base = {"description": "Pay", "account_id": accs["Chequing"], "amount": "10", "day_of_month": 1}
    not_a_loan = client.post("/api/recurring", json={**base, "loan_account_id": accs["Savings"]})
    assert not_a_loan.status_code == 400
    loan_id = make_loan()
    from_itself = client.post(
        "/api/recurring", json={**base, "account_id": loan_id, "loan_account_id": loan_id}
    )
    assert from_itself.status_code == 400
    no_category = client.post("/api/recurring", json=base)
    assert no_category.status_code == 400


def test_history_and_trend_track_the_balance(client, ids, make_loan):
    _, accs = ids
    account_id = make_loan()
    client.post(
        f"/api/loans/{account_id}/payments",
        json={"from_account_id": accs["Chequing"], "amount": "500", "date": "2026-02-01"},
    )
    loan = _loan(client, account_id)
    assert [row["owed_cents"] for row in loan["history"]] == [2_450_000]
    assert loan["history"][0]["owed_delta_cents"] == -50_000

    trend = client.get("/api/loans").json()["trend"]
    assert len(trend) == 12
    assert trend[-1]["owed_cents"] == 2_450_000
    # the month the loan opened carries the full opening balance; the payment lands after it
    opening_month = next(e for e in trend if e["month"] == "2026-01")
    assert opening_month["owed_cents"] == 2_500_000


def test_loan_type_config_is_editable(client):
    original = client.get("/api/settings/loan-types").json()["types"]
    try:
        assert {t["key"] for t in original} >= {"personal", "auto", "mortgage", "credit_card"}
        saved = client.put(
            "/api/settings/loan-types",
            json={"types": [{"key": "auto", "label": "Car"}, {"key": "ioan", "label": "IOU"}]},
        )
        assert saved.status_code == 200 and [t["key"] for t in saved.json()["types"]] == ["auto", "ioan"]
        assert client.get("/api/settings/loan-types").json()["types"][1]["label"] == "IOU"
        assert client.put("/api/settings/loan-types", json={"types": []}).status_code == 400
        assert client.put("/api/settings/loan-types", json={"types": [{"key": "a,b", "label": "x"}]}).status_code == 400
    finally:
        client.put("/api/settings/loan-types", json={"types": original})


def test_config_export_round_trips_loan_details(db, make_loan):
    from app.services.config_io import export_config

    make_loan()
    exported = export_config(db)
    card = next(a for a in exported["accounts"] if a["name"] == "Test Car Loan")
    assert card["kind"] == "debt"
    assert card["loan"]["loan_type"] == "auto" and card["loan"]["rate_bps"] == 649
    assert exported["settings"]["loan_types"]
