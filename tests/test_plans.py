"""Plans: hypothetical projections derived from data - CRUD, rolling window, goal progress, drift."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import delete


@pytest.fixture(autouse=True)
def _clean_plans(db):
    from app.models import Plan, PlanItem

    db.execute(delete(PlanItem))
    db.execute(delete(Plan))
    db.commit()
    yield


def _income_template(client, cats, accs, amount="2000"):
    """A recurring income template so the rolling plan has paychecks to look ahead to."""
    return client.post(
        "/api/recurring",
        json={
            "description": "Paycheque",
            "category_id": cats["Salary (net)"],
            "account_id": accs["Chequing"],
            "amount": amount,
            "day_of_month": 1,
            "schedule": {"freq": "monthly", "interval": 1, "start": "2020-01-01", "by_month_day": [1]},
            "is_active": True,
        },
    )


def test_plan_types_registry(client):
    types = client.get("/api/plan-types").json()
    keys = {t["key"] for t in types}
    assert {"rolling", "goal", "savings", "debt", "event", "scenario", "affordability"} <= keys
    rolling = next(t for t in types if t["key"] == "rolling")
    assert rolling["implemented"] and rolling["account_aware"]
    assert any(f["key"] == "lookahead_paychecks" for f in rolling["config_fields"])
    assert any(f["key"] == "paycheck_id" and f["kind"] == "paycheck" for f in rolling["config_fields"])
    savings = next(t for t in types if t["key"] == "savings")
    assert savings["implemented"] and not savings["account_aware"]
    assert any(f["key"] == "target_date" for f in savings["config_fields"])
    assert not any(f["key"] == "month" for f in savings["config_fields"])


def test_create_update_delete_plan(client, ids):
    _, accs = ids
    created = client.post(
        "/api/plans",
        json={"name": "Next two pays", "type": "rolling", "account_id": accs["Chequing"], "config": {}},
    )
    assert created.status_code == 201
    plan_id = created.json()["id"]

    got = client.get(f"/api/plans/{plan_id}").json()
    assert got["name"] == "Next two pays" and got["type"] == "rolling"
    # money config is normalised to cents
    assert got["config"]["buffer_cents"] == 0

    updated = client.put(
        f"/api/plans/{plan_id}",
        json={
            "name": "Renamed",
            "type": "rolling",
            "account_id": None,
            "status": "archived",
            "config": {"buffer_cents": "50"},
        },
    )
    assert updated.status_code == 200
    got = client.get(f"/api/plans/{plan_id}").json()
    assert got["name"] == "Renamed" and got["status"] == "archived"
    assert got["config"]["buffer_cents"] == 5000

    assert client.delete(f"/api/plans/{plan_id}").status_code == 204
    assert client.get(f"/api/plans/{plan_id}").status_code == 400


def test_rolling_projection_uses_paychecks_and_commitments(client, ids):
    cats, accs = ids
    assert _income_template(client, cats, accs).status_code == 201
    plan_id = client.post(
        "/api/plans",
        json={
            "name": "Rolling",
            "type": "rolling",
            "account_id": accs["Chequing"],
            "config": {"lookahead_paychecks": "2", "buffer_cents": "100"},
        },
    ).json()["id"]

    derived = client.get(f"/api/plans/{plan_id}").json()["derived"]
    assert derived["kind"] == "rolling"
    assert derived["lookahead_paychecks"] == 2
    assert len(derived["paychecks"]) == 2
    assert derived["inflow_cents"] > 0
    # the seeded Rent commitment falls in the window
    assert any(e["item_kind"] == "commitment" for e in derived["events"])
    assert derived["buffer_cents"] == 10000
    assert derived["safe_to_spend_cents"] == derived["inflow_cents"] - derived["outflow_cents"] - 10000


def test_rolling_counts_future_transactions_but_not_todays(client, ids):
    cats, accs = ids
    assert _income_template(client, cats, accs).status_code == 201

    def post(description, when, amount):
        client.post(
            "/api/transactions",
            json={
                "date": when,
                "description": description,
                "category_id": cats["Dining Out / Takeout"],
                "account_id": accs["Chequing"],
                "amount": amount,
                "notes": "",
            },
        )

    post("Upcoming bill", (date.today() + timedelta(days=5)).isoformat(), "25")
    post("Today bill", date.today().isoformat(), "40")

    plan_id = client.post(
        "/api/plans",
        json={"name": "Rolling", "type": "rolling", "account_id": accs["Chequing"], "config": {}},
    ).json()["id"]

    derived = client.get(f"/api/plans/{plan_id}").json()["derived"]
    ledger = [e for e in derived["events"] if e["source"] == "ledger"]
    # The window now spans the whole current month, so today's row shows too - it is still a real
    # movement, just one dated on or before today rather than hidden inside the opening balance.
    assert [e["description"] for e in ledger] == ["Today bill", "Upcoming bill"]
    assert ledger[0]["amount_cents"] == 4000 and ledger[0]["direction"] == "out"


def test_rolling_window_includes_past_expense_and_match_status(client, ids):
    cats, accs = ids
    assert _income_template(client, cats, accs).status_code == 201
    first = date.today().replace(day=1)

    client.post(
        "/api/recurring",
        json={
            "description": "Utilities",
            "category_id": cats["Utilities"],
            "account_id": accs["Chequing"],
            "amount": "40",
            "day_of_month": 1,
            "schedule": {"freq": "monthly", "interval": 1, "start": "2020-01-01", "by_month_day": [1]},
            "is_active": True,
        },
    )
    client.post(
        "/api/transactions",
        json={
            "date": first.isoformat(),
            "description": "Utilities",
            "category_id": cats["Utilities"],
            "account_id": accs["Chequing"],
            "amount": "40",
            "notes": "",
        },
    )

    plan_id = client.post(
        "/api/plans",
        json={"name": "Rolling", "type": "rolling", "account_id": accs["Chequing"], "config": {}},
    ).json()["id"]

    events = client.get(f"/api/plans/{plan_id}").json()["derived"]["events"]
    occ = [
        e
        for e in events
        if e["source"] == "recurring" and e["description"] == "Utilities" and e["date"] == first.isoformat()
    ]
    # The already-passed occurrence is no longer skipped, and drift-matched it to the real transaction.
    assert len(occ) == 1
    assert occ[0]["matched_transaction_id"] is not None
    assert occ[0]["actual_cents"] == -4000


def test_rolling_paycheck_can_be_chosen(client, ids):
    cats, accs = ids
    assert _income_template(client, cats, accs, amount="1000").status_code == 201
    chosen = client.post(
        "/api/recurring",
        json={
            "description": "Second job",
            "category_id": cats["Salary (net)"],
            "account_id": accs["Chequing"],
            "amount": "500",
            "day_of_month": 15,
            "schedule": {"freq": "monthly", "interval": 1, "start": "2020-01-01", "by_month_day": [15]},
            "is_active": True,
        },
    ).json()["id"]

    plan_id = client.post(
        "/api/plans",
        json={
            "name": "Second job only",
            "type": "rolling",
            "account_id": accs["Chequing"],
            "config": {"paycheck_id": str(chosen), "lookahead_paychecks": "2"},
        },
    ).json()["id"]

    derived = client.get(f"/api/plans/{plan_id}").json()["derived"]
    assert derived["paycheck"]["id"] == chosen
    assert len(derived["paychecks"]) == 2
    assert all(date.fromisoformat(p["date"]).day == 15 for p in derived["paychecks"])

    # a paycheck must be recurring income; the seeded Rent template is an expense
    expense_id = next(r["id"] for r in client.get("/api/recurring").json() if r["description"] == "Rent")
    bad = client.post(
        "/api/plans",
        json={"name": "Bad", "type": "rolling", "config": {"paycheck_id": str(expense_id)}},
    )
    assert bad.status_code == 400


def test_recurring_exposes_income_flag(client, ids):
    cats, accs = ids
    assert _income_template(client, cats, accs).status_code == 201
    rows = client.get("/api/recurring").json()
    assert any(r["description"] == "Paycheque" and r["is_income"] for r in rows)


def test_rolling_counts_budgeted_variable_spending(client, ids):
    cats, accs = ids
    plan_id = client.post(
        "/api/plans",
        json={
            "name": "Variable",
            "type": "rolling",
            "account_id": accs["Chequing"],
            "start_date": "2026-01-01",
            "end_date": "2026-02-28",
            "config": {"variable_category_ids": [cats["Grocery"]]},
        },
    ).json()["id"]

    derived = client.get(f"/api/plans/{plan_id}").json()["derived"]
    assert derived["variable_category_count"] == 1
    # Grocery's 60000 monthly budget, applied to each calendar month the window spans (Jan + Feb).
    assert derived["variable_spending_cents"] == 120000


def test_event_plan_events_show_target_account_balance(client, ids):
    from datetime import timedelta

    cats, accs = ids
    yesterday = date.today() - timedelta(days=1)
    client.post(
        "/api/transactions",
        json={
            "date": yesterday.isoformat(),
            "description": "Pay",
            "category_id": cats["Salary (net)"],
            "account_id": accs["Chequing"],
            "amount": "1000",
            "notes": "",
        },
    )
    plan_id = client.post(
        "/api/plans",
        json={
            "name": "Trip",
            "type": "event",
            "account_id": accs["Chequing"],
            "config": {"budget_cents": "500"},
        },
    ).json()["id"]
    tomorrow = date.today() + timedelta(days=1)
    for when, amount in ((tomorrow, "50"), (date.today(), "100")):
        client.post(
            f"/api/plans/{plan_id}/items",
            json={"date": when.isoformat(), "description": amount, "amount": amount, "direction": "out"},
        )

    events = client.get(f"/api/plans/{plan_id}").json()["derived"]["events"]
    assert [e["date"] for e in events] == [date.today().isoformat(), tomorrow.isoformat()]
    assert [e["balance_cents"] for e in events] == [90000, 85000]


def test_goal_progress_from_funding_category(client, ids):
    cats, accs = ids
    plan_id = client.post(
        "/api/plans",
        json={
            "name": "New laptop",
            "type": "goal",
            "account_id": None,
            "config": {"target_cents": "1200", "category_id": cats["Grocery"]},
        },
    ).json()["id"]

    # a contribution toward the goal
    client.post(
        "/api/transactions",
        json={
            "date": date.today().isoformat(),
            "description": "Save for laptop",
            "category_id": cats["Grocery"],
            "account_id": accs["Chequing"],
            "amount": "300",
            "notes": "",
        },
    )

    derived = client.get(f"/api/plans/{plan_id}").json()["derived"]
    assert derived["kind"] == "goal"
    assert derived["target_cents"] == 120000
    assert derived["funded_cents"] == 30000
    assert derived["remaining_cents"] == 90000
    assert derived["progress_pct"] == 25.0


def test_goal_funding_nets_spending_against_target_account(client, ids):
    cats, accs = ids
    plan_id = client.post(
        "/api/plans",
        json={
            "name": "Holiday fund",
            "type": "goal",
            "account_id": accs["Savings"],
            "config": {"target_cents": "1000", "category_id": cats["Grocery"]},
        },
    ).json()["id"]

    # Money leaving Chequing (not the target account) is a contribution into the fund.
    client.post(
        "/api/transactions",
        json={
            "date": date.today().isoformat(),
            "description": "Move to holiday fund",
            "category_id": cats["Grocery"],
            "account_id": accs["Chequing"],
            "amount": "300",
            "notes": "",
        },
    )
    # Money leaving Savings (the target account) is spending drawn from the fund.
    client.post(
        "/api/transactions",
        json={
            "date": date.today().isoformat(),
            "description": "Booked a flight",
            "category_id": cats["Grocery"],
            "account_id": accs["Savings"],
            "amount": "100",
            "notes": "",
        },
    )

    derived = client.get(f"/api/plans/{plan_id}").json()["derived"]
    funding = derived["funding"]
    assert funding["account_name"] == "Savings"
    assert funding["in_cents"] == 30000
    assert funding["out_cents"] == 10000
    assert funding["net_cents"] == 20000
    assert [t["direction"] for t in funding["transactions"]] == ["in", "out"]
    # The headline funded figure is the net, so spending no longer inflates progress.
    assert derived["funded_cents"] == 20000
    assert derived["remaining_cents"] == 80000


def test_savings_window_projects_months_and_tracks_target(client, ids):
    cats, accs = ids
    today = date.today()
    this_month = today.replace(day=1)
    last_month = (this_month - timedelta(days=1)).replace(day=1)
    next_month = (this_month + timedelta(days=32)).replace(day=1)

    # Spend 400 in an elapsed month (Grocery's budget is 60000), so it shows as actual.
    client.post(
        "/api/transactions",
        json={
            "date": (last_month + timedelta(days=10)).isoformat(),
            "description": "Groceries",
            "category_id": cats["Grocery"],
            "account_id": accs["Chequing"],
            "amount": "400",
            "notes": "",
        },
    )
    plan_id = client.post(
        "/api/plans",
        json={
            "name": "Holiday fund",
            "type": "savings",
            "account_id": None,
            "start_date": last_month.isoformat(),
            "config": {"target_cents": "2000", "target_date": next_month.isoformat(), "category_id": cats["Grocery"]},
        },
    ).json()["id"]

    derived = client.get(f"/api/plans/{plan_id}").json()["derived"]
    assert derived["kind"] == "savings"
    # The window runs from the start month to the target month, inclusive.
    assert derived["window"] == {"start": last_month.isoformat()[:7], "end": next_month.isoformat()[:7]}

    months = derived["months"]
    assert [m["month"] for m in months] == [
        last_month.isoformat()[:7],
        this_month.isoformat()[:7],
        next_month.isoformat()[:7],
    ]
    # Only the fully-elapsed month is actual; this month and the target month are projected.
    assert [m["kind"] for m in months] == ["actual", "projected", "projected"]
    assert months[-1]["cumulative_cents"] == derived["net_cents"] == sum(m["net_cents"] for m in months)

    # Categories compare budget vs actual across elapsed months only.
    grocery = next(c for c in derived["categories"] if c["name"] == "Grocery")
    assert grocery["budget_cents"] == 60000
    assert grocery["actual_cents"] == 40000
    assert grocery["remaining_cents"] == 20000
    assert derived["underspend_cents"] >= 20000

    # The elapsed-month grocery transaction also funds the target via the funding category.
    assert derived["target_cents"] == 200000
    assert derived["funded_cents"] == 40000
    assert derived["remaining_cents"] == 160000
    assert derived["progress_pct"] == 20.0
    assert derived["headline_cents"] == derived["net_cents"]


def test_plan_item_crud_and_drift_match(client, ids):
    cats, accs = ids
    plan_id = client.post(
        "/api/plans", json={"name": "Event", "type": "event", "config": {}}
    ).json()["id"]

    item_id = client.post(
        f"/api/plans/{plan_id}/items",
        json={
            "date": date.today().isoformat(),
            "description": "Venue deposit",
            "category_id": cats["Dining Out / Takeout"],
            "account_id": accs["Chequing"],
            "amount": "60",
            "direction": "out",
            "item_kind": "custom",
        },
    ).json()["id"]

    # a real transaction that fulfils the planned item
    client.post(
        "/api/transactions",
        json={
            "date": date.today().isoformat(),
            "description": "Venue deposit",
            "category_id": cats["Dining Out / Takeout"],
            "account_id": accs["Chequing"],
            "amount": "60",
            "notes": "",
        },
    )

    detail = client.get(f"/api/plans/{plan_id}").json()
    assert detail["item_count"] == 1
    item_event = next(e for e in detail["events"] if e["item_id"] == item_id)
    # The wire keeps the magnitude + direction pair even though the stream works in signed amounts.
    assert item_event["amount_cents"] == 6000 and item_event["direction"] == "out"
    assert item_event["actual_cents"] == -6000
    assert item_event["variance_cents"] == 0
    assert item_event["matched_transaction_id"] is not None

    # editing the item persists, then deleting it removes it
    assert client.put(
        f"/api/plans/{plan_id}/items/{item_id}",
        json={"description": "Updated", "amount": "75", "direction": "out", "item_kind": "custom"},
    ).status_code == 200
    detail = client.get(f"/api/plans/{plan_id}").json()
    assert detail["items"][0]["description"] == "Updated"
    assert detail["items"][0]["amount_cents"] == 7500

    assert client.delete(f"/api/plans/{plan_id}/items/{item_id}").status_code == 204
    assert client.get(f"/api/plans/{plan_id}").json()["item_count"] == 0


def test_plan_validation_errors(client):
    assert client.post("/api/plans", json={"name": "", "type": "rolling"}).status_code == 400
    assert client.post("/api/plans", json={"name": "X", "type": "nope"}).status_code == 400


def _add_debt_item(client, plan_id, name, amount):
    return client.post(
        f"/api/plans/{plan_id}/items",
        json={"description": name, "amount": amount, "direction": "out", "item_kind": "debt"},
    ).json()["id"]


def test_debt_payoff_projection(client):
    plan_id = client.post(
        "/api/plans",
        json={
            "name": "Pay off cards",
            "type": "debt",
            "config": {"monthly_payment_cents": "300", "strategy": "avalanche"},
        },
    ).json()["id"]
    _add_debt_item(client, plan_id, "Visa", "1000")
    _add_debt_item(client, plan_id, "Store card", "500")

    d = client.get(f"/api/plans/{plan_id}").json()["derived"]
    assert d["kind"] == "debt"
    assert d["monthly_payment_cents"] == 30000
    # 1500 owed at 300/mo -> 5 months, no interest
    assert d["months_to_payoff"] == 5
    assert d["total_interest_cents"] == 0
    by_name = {x["name"]: x for x in d["debts"]}
    assert by_name["Visa"]["payoff_month"] == 4  # largest balance paid first
    assert by_name["Store card"]["payoff_month"] == 5


def test_debt_payoff_with_interest_extends_term(client):
    plan_id = client.post(
        "/api/plans",
        json={"name": "Card", "type": "debt", "config": {"monthly_payment_cents": "100", "apr_pct": "12"}},
    ).json()["id"]
    _add_debt_item(client, plan_id, "Visa", "1000")
    d = client.get(f"/api/plans/{plan_id}").json()["derived"]
    assert d["total_interest_cents"] > 0
    assert d["months_to_payoff"] > 10  # vs 10 months with no interest


def test_event_budget_vs_estimate(client):
    plan_id = client.post(
        "/api/plans",
        json={"name": "Move", "type": "event", "config": {"budget_cents": "1000"}},
    ).json()["id"]
    for desc, amount in (("Truck", "400"), ("Deposit", "700")):
        client.post(
            f"/api/plans/{plan_id}/items",
            json={"description": desc, "amount": amount, "direction": "out", "item_kind": "custom"},
        )
    d = client.get(f"/api/plans/{plan_id}").json()["derived"]
    assert d["kind"] == "event"
    assert d["budget_cents"] == 100000
    assert d["estimate_cents"] == 110000
    assert d["remaining_cents"] == -10000


def test_scenario_adjusts_this_months_actuals(client, ids):
    cats, accs = ids
    for desc, category, amount in (("Pay", cats["Salary (net)"], "1000"), ("Food", cats["Grocery"], "500")):
        client.post(
            "/api/transactions",
            json={
                "date": date.today().isoformat(),
                "description": desc,
                "category_id": category,
                "account_id": accs["Chequing"],
                "amount": amount,
                "notes": "",
            },
        )
    plan_id = client.post(
        "/api/plans",
        json={
            "name": "Raise",
            "type": "scenario",
            "config": {"income_adjust_pct": "10", "expense_adjust_pct": "-10"},
        },
    ).json()["id"]
    d = client.get(f"/api/plans/{plan_id}").json()["derived"]
    assert d["kind"] == "scenario"
    assert d["base_income_cents"] == 100000 and d["base_expense_cents"] == 50000
    assert d["income_cents"] == 110000
    assert d["expense_cents"] == 45000
    assert d["net_cents"] == 65000


def test_affordability_checks_projected_balance(client, ids):
    cats, accs = ids
    client.post(
        "/api/transactions",
        json={
            "date": date.today().isoformat(),
            "description": "Pay",
            "category_id": cats["Salary (net)"],
            "account_id": accs["Chequing"],
            "amount": "2000",
            "notes": "",
        },
    )

    def make(purchase):
        plan_id = client.post(
            "/api/plans",
            json={
                "name": "Buy",
                "type": "affordability",
                "account_id": accs["Chequing"],
                "config": {"purchase_cents": purchase, "purchase_date": date.today().isoformat()},
            },
        ).json()["id"]
        return client.get(f"/api/plans/{plan_id}").json()["derived"]

    ok = make("1500")
    assert ok["balance_before_cents"] == 200000
    assert ok["balance_after_cents"] == 50000
    assert ok["affordable"] is True and ok["shortfall_cents"] == 0

    over = make("3000")
    assert over["affordable"] is False
    assert over["shortfall_cents"] == 100000


def test_all_types_report_implemented(client):
    types = {t["key"]: t for t in client.get("/api/plan-types").json()}
    assert all(t["implemented"] for t in types.values())

def test_goal_progress_from_payments_to_a_loan(client, ids, db):
    from app.models import Account, Transaction
    from app.services import transfers

    cats, accs = ids
    loan = Account(name="Plan Loan", kind="debt", opening_balance_cents=-100000, opening_date=date(2026, 1, 1))
    db.add(loan)
    db.commit()
    plan_id = None
    try:
        plan_id = client.post(
            "/api/plans",
            json={
                "name": "Pay off loan",
                "type": "savings",
                "account_id": None,
                "start_date": "2026-01-01",
                "config": {"target_cents": "1000", "category_id": cats["Grocery"], "loan_account_id": loan.id},
            },
        ).json()["id"]
        transfers.create_transfer(
            db,
            on_date=date.today(),
            description="Payment",
            amount_cents=25000,
            from_account_id=accs["Chequing"],
            to_account_id=loan.id,
            notes=None,
        )
        derived = client.get(f"/api/plans/{plan_id}").json()["derived"]
        assert derived["funded_cents"] == 25000
        assert derived["progress_pct"] == 25.0
        assert derived["funding"]["account_name"] == "Plan Loan"
        assert derived["funding"]["category_path"] == "Payments to Plan Loan"
        assert [t["signed_cents"] for t in derived["funding"]["transactions"]] == [25000]
    finally:
        if plan_id is not None:
            client.delete(f"/api/plans/{plan_id}")
        db.query(Transaction).delete()
        db.delete(loan)
        db.commit()
