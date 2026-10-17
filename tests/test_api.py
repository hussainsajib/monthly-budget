"""JSON API used by the React front end."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import delete

from app.models import Account, Category, RecurringTemplate, Transaction
from app.spa import DIST


def _txn_body(cats, accs, **overrides):
    body = {
        "date": "2026-05-04",
        "description": "Corner Cafe",
        "category_id": cats["Dining Out / Takeout"],
        "account_id": accs["Chequing"],
        "amount": "39.55",
        "notes": "",
    }
    return body | overrides


def test_categories_are_returned_in_tree_order(client, ids):
    cats, _ = ids
    rows = client.get("/api/categories").json()
    by_id = {r["id"]: r for r in rows}
    rent = by_id[cats["Rent"]]
    assert (rent["depth"], rent["path"], rent["kind"]) == (1, "Fixed Expenses › Rent", "expense")
    assert rent["budget_cents"] == 150000 and rent["has_children"] is False
    section = by_id[rent["parent_id"]]
    assert section["has_children"] and section["effective_budget_cents"] > rent["budget_cents"]
    # a parent always precedes its children
    assert [r["id"] for r in rows].index(section["id"]) < [r["id"] for r in rows].index(rent["id"])


def test_category_rows_report_child_and_recurring_usage(client, ids):
    """The UI gates its delete flow on these counts, so they must cover everything the server blocks on."""
    cats, accs = ids
    parent_id = cats["Discretionary"]
    leaf_id = client.post("/api/categories", json={"name": "Counted", "parent_id": parent_id}).json()["id"]
    tpl_id = client.post(
        "/api/recurring",
        json={"description": "Counted rule", "category_id": leaf_id, "account_id": accs["Chequing"], "amount": "5"},
    ).json()["id"]
    try:
        rows = {r["id"]: r for r in client.get("/api/categories").json()}
        assert rows[parent_id]["child_count"] > 0
        assert rows[parent_id]["recurring_count"] == 0  # rules only ever attach to leaves
        assert (rows[leaf_id]["child_count"], rows[leaf_id]["transaction_count"]) == (0, 0)
        assert rows[leaf_id]["recurring_count"] == 1

        # A recurring rule alone makes the delete unsafe, even with no transactions attached.
        assert client.delete(f"/api/categories/{leaf_id}").status_code == 400
        assert client.delete(f"/api/categories/{leaf_id}", params={"move_to_id": cats["Grocery"]}).status_code == 204
        moved = next(t for t in client.get("/api/recurring").json() if t["id"] == tpl_id)
        assert moved["category_path"] == "Essential Variable › Grocery"
    finally:
        client.delete(f"/api/recurring/{tpl_id}")


def test_category_create_update_delete(client, db, ids):
    cats, _ = ids
    res = client.post("/api/categories", json={"name": "Pets", "parent_id": cats["Discretionary"], "budget": "12.50"})
    assert res.status_code == 201
    new_id = res.json()["id"]
    try:
        row = next(r for r in client.get("/api/categories").json() if r["id"] == new_id)
        assert (row["budget_cents"], row["kind"]) == (1250, "expense")

        dup = client.post("/api/categories", json={"name": "pets", "parent_id": cats["Discretionary"]})
        assert dup.status_code == 400 and "already exists" in dup.json()["detail"]

        res = client.put(
            f"/api/categories/{new_id}",
            json={
                "name": "Pet care",
                "parent_id": cats["Discretionary"],
                "kind": "expense",
                "budget": "20",
                "description": "",
                "sort_order": 5,
                "is_active": False,
            },
        )
        assert res.status_code == 200
        row = next(r for r in client.get("/api/categories").json() if r["id"] == new_id)
        assert (row["name"], row["budget_cents"], row["is_active"]) == ("Pet care", 2000, False)
    finally:
        client.delete(f"/api/categories/{new_id}")
    assert db.get(Category, new_id) is None


def test_deleting_category_with_transactions_needs_a_target(client, db, ids):
    cats, accs = ids
    new_id = client.post("/api/categories", json={"name": "Temp", "parent_id": cats["Discretionary"]}).json()["id"]
    client.post("/api/transactions", json=_txn_body(cats, accs, category_id=new_id))
    try:
        res = client.delete(f"/api/categories/{new_id}")
        assert res.status_code == 400 and "move" in res.json()["detail"]
        res = client.delete(f"/api/categories/{new_id}", params={"move_to_id": cats["Grocery"]})
        assert res.status_code == 204
        assert db.query(Transaction).one().category_id == cats["Grocery"]
    finally:
        db.execute(delete(Category).where(Category.id == new_id))
        db.commit()


def test_transaction_crud_and_listing(client, ids):
    cats, accs = ids
    res = client.post("/api/transactions", json=_txn_body(cats, accs))
    assert res.status_code == 201
    created = res.json()
    assert created["amount_cents"] == 3955 and created["category_path"] == "Discretionary › Dining Out / Takeout"

    res = client.put(
        f"/api/transactions/{created['id']}",
        json=_txn_body(cats, accs, category_id=cats["Grocery"], account_id=None, amount="40", notes="fixed"),
    )
    assert res.status_code == 200
    assert (res.json()["category_id"], res.json()["amount_cents"], res.json()["account_id"]) == (
        cats["Grocery"],
        4000,
        None,
    )
    assert client.get(f"/api/transactions/{created['id']}").json()["notes"] == "fixed"

    listing = client.get("/api/transactions", params={"q": "cafe"}).json()
    assert listing["total"] == 1 and listing["pages"] == 1
    # filtering by a top-level section includes its sub-categories
    section_id = next(r["parent_id"] for r in client.get("/api/categories").json() if r["id"] == cats["Grocery"])
    assert client.get("/api/transactions", params={"category_id": section_id}).json()["total"] == 1
    assert client.get("/api/transactions", params={"category_id": cats["Rent"]}).json()["total"] == 0

    assert client.get("/api/transactions/recent").json()[0]["id"] == created["id"]
    assert "Corner Cafe" in client.get("/api/transactions/descriptions").json()

    assert client.delete(f"/api/transactions/{created['id']}").status_code == 204
    assert client.get(f"/api/transactions/{created['id']}").status_code == 404


def test_transaction_duplicate_lookup(client, ids):
    cats, accs = ids
    client.post("/api/transactions", json=_txn_body(cats, accs, description="Corner Cafe", amount="39.55"))

    hit = client.get(
        "/api/transactions/duplicates",
        params={"date": "2026-05-04", "amount": "39.55", "account_id": accs["Chequing"]},
    ).json()
    assert [h["description"] for h in hit] == ["Corner Cafe"]

    # a different amount on the same day/account is not a duplicate
    assert (
        client.get(
            "/api/transactions/duplicates",
            params={"date": "2026-05-04", "amount": "10", "account_id": accs["Chequing"]},
        ).json()
        == []
    )

    # a refund of the same amount still matches (amount is compared in absolute terms)
    assert (
        client.get(
            "/api/transactions/duplicates",
            params={"date": "2026-05-04", "amount": "-39.55", "account_id": accs["Chequing"]},
        ).json()[0]["description"]
        == "Corner Cafe"
    )

    # editing a row never flags itself
    existing_id = client.get("/api/transactions").json()["items"][0]["id"]
    assert (
        client.get(
            "/api/transactions/duplicates",
            params={
                "date": "2026-05-04",
                "amount": "39.55",
                "account_id": accs["Chequing"],
                "exclude_id": existing_id,
            },
        ).json()
        == []
    )


def test_transaction_validation_errors_are_plain_messages(client, ids, db):
    cats, accs = ids
    section_id = next(r["id"] for r in client.get("/api/categories").json() if r["depth"] == 0)
    res = client.post("/api/transactions", json=_txn_body(cats, accs, category_id=section_id))
    assert res.status_code == 400 and res.json()["detail"] == "Pick a category"

    res = client.post("/api/transactions", json=_txn_body(cats, accs, amount="abc"))
    assert res.status_code == 400 and "valid amount" in res.json()["detail"]

    res = client.post("/api/transactions", json=_txn_body(cats, accs, description="   "))
    assert res.status_code == 400 and res.json()["detail"] == "Description is required"
    assert db.query(Transaction).count() == 0


def test_amount_expressions_and_refunds(client, ids):
    cats, accs = ids
    res = client.post("/api/transactions", json=_txn_body(cats, accs, amount="61.09+1.37"))
    assert res.json()["amount_cents"] == 6246
    res = client.post("/api/transactions", json=_txn_body(cats, accs, amount="-5"))
    assert res.json()["amount_cents"] == -500


def test_transactions_can_be_sorted(client, ids):
    cats, accs = ids
    client.post("/api/transactions", json=_txn_body(cats, accs, description="Aaa", amount="10"))
    client.post("/api/transactions", json=_txn_body(cats, accs, description="Zzz", amount="30"))
    asc = client.get("/api/transactions", params={"sort": "amount", "dir": "asc"}).json()["items"]
    assert [t["description"] for t in asc] == ["Aaa", "Zzz"]
    desc = client.get("/api/transactions", params={"sort": "amount", "dir": "desc"}).json()["items"]
    assert [t["description"] for t in desc] == ["Zzz", "Aaa"]
    by_cat = client.get("/api/transactions", params={"sort": "category", "dir": "asc"}).json()["items"]
    assert len(by_cat) == 2


def test_account_create_update_and_duplicate(client, db):
    body = {"name": "API Test Account", "kind": "bank", "opening_balance": "100.00", "opening_date": "2026-01-01"}
    res = client.post("/api/accounts", json=body)
    assert res.status_code == 201
    acc_id = res.json()["id"]
    try:
        assert res.json()["opening_balance_cents"] == 10000
        assert client.post("/api/accounts", json=body).status_code == 400
        assert client.post("/api/accounts", json=body | {"name": "x", "kind": "gold"}).status_code == 400
        res = client.put(f"/api/accounts/{acc_id}", json=body | {"opening_balance": "0", "is_active": False})
        assert (res.json()["opening_balance_cents"], res.json()["is_active"]) == (0, False)
        assert acc_id not in [a["id"] for a in client.get("/api/accounts", params={"include_inactive": False}).json()]
        assert acc_id in [a["id"] for a in client.get("/api/accounts").json()]
    finally:
        db.execute(delete(Account).where(Account.id == acc_id))
        db.commit()


def test_account_delete(client, db):
    body = {"name": "Delete Me", "kind": "bank", "opening_balance": "5", "opening_date": None}
    acc_id = client.post("/api/accounts", json=body).json()["id"]
    assert client.delete(f"/api/accounts/{acc_id}").status_code == 204
    assert db.get(Account, acc_id) is None
    assert client.delete(f"/api/accounts/{acc_id}").status_code == 204  # deleting again is a no-op


def test_account_stats(client, ids):
    cats, accs = ids
    body = {"name": "Stats Acct", "kind": "bank", "opening_balance": "100", "opening_date": "2026-01-01"}
    acc_id = client.post("/api/accounts", json=body).json()["id"]
    try:
        client.post("/api/transactions", json=_txn_body(cats, accs, date="2026-05-04", account_id=acc_id))
        row = next(a for a in client.get("/api/accounts").json() if a["id"] == acc_id)
        assert row["current_balance_cents"] == 10000 - 3955
        assert row["transaction_count"] == 1
        assert row["transacted_cents"] == 3955
    finally:
        client.delete(f"/api/accounts/{acc_id}")


def test_accounts_sort_by_balance(client, db):
    made = {}
    seeds = [("Sort Zeta", "bank", "10"), ("Sort Alpha", "cash", "300"), ("Sort Mid", "savings", "100")]
    for name, kind, balance in seeds:
        res = client.post("/api/accounts", json={"name": name, "kind": kind, "opening_balance": balance})
        made[name] = res.json()["id"]
    try:
        def balances(**params):
            rows = client.get("/api/accounts", params={"include_inactive": False, **params}).json()
            return [(r["name"], r["current_balance_cents"]) for r in rows if r["id"] in made.values()]

        def names(**params):
            return [n for n, _ in balances(**params)]

        assert balances(sort="balance", dir="asc") == [("Sort Zeta", 1000), ("Sort Mid", 10000), ("Sort Alpha", 30000)]
        assert balances(sort="balance", dir="desc") == list(reversed(balances(sort="balance", dir="asc")))
        assert names(sort="name", dir="asc") == ["Sort Alpha", "Sort Mid", "Sort Zeta"]
        assert names(sort="name", dir="desc") == list(reversed(names(sort="name", dir="asc")))
        assert names() == ["Sort Alpha", "Sort Mid", "Sort Zeta"]  # name asc is the default
        assert client.get("/api/accounts", params={"sort": "nope"}).status_code == 400
        assert client.get("/api/accounts", params={"dir": "sideways"}).status_code == 400
    finally:
        for acc_id in made.values():
            client.delete(f"/api/accounts/{acc_id}")


def test_recurring_sort(client, db, ids):
    cats, accs = ids
    made = {}
    for desc, category, account, amount in [
        ("Sort Zeta", cats["Rent"], accs["Chequing"], "10"),
        ("Sort Alpha", cats["Grocery"], accs["Savings"], "300"),
        ("Sort Mid", cats["Rent"], accs["Savings"], "100"),
    ]:
        body = {
            "description": desc,
            "category_id": category,
            "account_id": account,
            "amount": amount,
            "day_of_month": 1,
        }
        made[desc] = client.post("/api/recurring", json=body).json()["id"]
    try:
        def rows(**params):
            return [
                (t["description"], t["amount_cents"])
                for t in client.get("/api/recurring", params=params).json()
                if t["id"] in made.values()
            ]

        def names(**params):
            return [d for d, _ in rows(**params)]

        assert rows(sort="amount", dir="asc") == [("Sort Zeta", 1000), ("Sort Mid", 10000), ("Sort Alpha", 30000)]
        assert rows(sort="amount", dir="desc") == list(reversed(rows(sort="amount", dir="asc")))
        assert names(sort="description", dir="asc") == ["Sort Alpha", "Sort Mid", "Sort Zeta"]
        assert names(sort="description", dir="desc") == list(reversed(names(sort="description", dir="asc")))
        assert names() == ["Sort Alpha", "Sort Mid", "Sort Zeta"]  # description asc is the default
        assert client.get("/api/recurring", params={"sort": "nope"}).status_code == 400
        assert client.get("/api/recurring", params={"dir": "sideways"}).status_code == 400
    finally:
        for tpl_id in made.values():
            client.delete(f"/api/recurring/{tpl_id}")


def test_recurring_crud_and_budget(client, db, ids):
    cats, accs = ids

    def rent_recurring(month: str) -> int:
        return next(
            line["recurring_cents"]
            for line in client.get("/api/budget", params={"month": month}).json()["lines"]
            if line["category_id"] == cats["Rent"]
        )

    base = rent_recurring("2026-02")
    body = {
        "description": "API rent",
        "category_id": cats["Rent"],
        "account_id": accs["Chequing"],
        "amount": "1000",
        "day_of_month": 31,
    }
    tpl_id = client.post("/api/recurring", json=body).json()["id"]
    try:
        assert client.post("/api/recurring", json=body | {"day_of_month": 32}).status_code == 400
        listed = next(t for t in client.get("/api/recurring").json() if t["id"] == tpl_id)
        assert (listed["amount_cents"], listed["category_path"]) == (100000, "Fixed Expenses › Rent")

        assert rent_recurring("2026-02") == base + 100000  # recurring shows in its own columns
        # Recurring items never create transactions — only manual entry or bulk import do.
        assert client.get("/api/transactions", params={"q": "API rent"}).json()["items"] == []

        assert client.put(f"/api/recurring/{tpl_id}", json=body | {"is_active": False}).status_code == 200
        assert rent_recurring("2026-02") == base  # archived templates stop contributing
    finally:
        client.delete(f"/api/recurring/{tpl_id}")
    assert db.get(RecurringTemplate, tpl_id) is None


CSV = (
    "Date,Description,Amount\n"
    "2026-03-01,FRESH MART #123,45.10\n"
    "2026-03-02,PAYCHEQUE,-500.00\n"
)


def test_import_rule_matches_on_amount(client, ids):
    cats, accs = ids
    cc = accs["Credit Card"]
    files = {"file": ("bank.csv", CSV, "text/csv")}
    data = {"account_id": str(cc), "amount_sign": "positive_is_expense"}

    rule = {"match_text": "", "amount": "45.10", "account_id": cc, "category_id": cats["Dining Out / Takeout"]}
    rule_id = client.post("/api/import-rules", json=rule).json()["id"]
    try:
        rows = client.post("/api/import/preview", files=files, data=data).json()
        assert rows[0]["category_id"] == cats["Dining Out / Takeout"]  # the 45.10 charge matches
        assert rows[1]["category_id"] is None  # the 500.00 deposit doesn't
    finally:
        client.delete(f"/api/import-rules/{rule_id}")


def test_recurring_schedule_budget(client, ids):
    cats, accs = ids

    def grocery_recurring(month: str) -> int:
        return next(
            line["recurring_cents"]
            for line in client.get("/api/budget", params={"month": month}).json()["lines"]
            if line["category_id"] == cats["Grocery"]
        )

    base = grocery_recurring("2026-02")
    body = {
        "description": "Biweekly gas",
        "category_id": cats["Grocery"],
        "account_id": accs["Chequing"],
        "amount": "10",
        "schedule": {"freq": "weekly", "interval": 2, "start": "2026-01-05", "by_weekday": [0]},
        "is_active": True,
    }
    tpl_id = client.post("/api/recurring", json=body).json()["id"]
    try:
        listed = next(t for t in client.get("/api/recurring").json() if t["id"] == tpl_id)
        assert listed["schedule"] == body["schedule"]
        assert grocery_recurring("2026-02") == base + 2000  # biweekly -> 2 occurrences in Feb
        assert client.get("/api/transactions", params={"q": "Biweekly gas"}).json()["items"] == []
        bad = client.post(
            "/api/recurring", json=body | {"schedule": {"freq": "monthly", "interval": 1, "start": "2026-01-01"}}
        )
        assert bad.status_code == 400
    finally:
        client.delete(f"/api/recurring/{tpl_id}")


def test_import_preview_and_commit_are_idempotent(client, ids):
    cats, accs = ids
    files = {"file": ("bank.csv", CSV, "text/csv")}
    data = {"account_id": str(accs["Credit Card"]), "amount_sign": "positive_is_expense"}
    rows = client.post("/api/import/preview", files=files, data=data).json()
    assert [(r["description"], r["amount_cents"], r["direction"]) for r in rows] == [
        ("FRESH MART #123", 4510, "out"),
        ("PAYCHEQUE", 50000, "in"),
    ]
    assert not any(r["duplicate"] for r in rows)

    # a row without a usable category is refused and nothing is saved
    section_id = next(r["id"] for r in client.get("/api/categories").json() if r["depth"] == 0)
    fields = ("date", "description", "amount_cents", "direction", "key")
    bad = [{k: r[k] for k in fields} | {"category_id": section_id} for r in rows]
    commit = {"account_id": accs["Credit Card"], "rows": bad}
    assert client.post("/api/import/commit", json=commit).status_code == 400
    assert client.get("/api/transactions").json()["total"] == 0

    category_for = {"out": cats["Grocery"], "in": cats["Other Income"]}
    good = [{k: r[k] for k in fields} | {"category_id": category_for[r["direction"]]} for r in rows]
    commit = {"account_id": accs["Credit Card"], "rows": good}
    assert client.post("/api/import/commit", json=commit).json() == {"imported": 2}

    again = client.post("/api/import/preview", files={"file": ("bank.csv", CSV, "text/csv")}, data=data).json()
    assert all(r["duplicate"] for r in again)
    # learned suggestions: the same merchant is now pre-categorised
    assert again[0]["category_id"] == cats["Grocery"]


def test_import_rejects_unreadable_files(client):
    res = client.post("/api/import/preview", files={"file": ("x.csv", "foo,bar\n1,2\n", "text/csv")})
    assert res.status_code == 400 and "columns" in res.json()["detail"]


def test_import_rules_auto_assign_in_preview(client, ids):
    cats, accs = ids
    cc = accs["Credit Card"]
    files = {"file": ("bank.csv", CSV, "text/csv")}
    data = {"account_id": str(cc), "amount_sign": "positive_is_expense"}

    # validation: a rule needs at least one identifier (text, amount or date), a real account and
    # an assignable (non-section) category
    section = next(r["id"] for r in client.get("/api/categories").json() if r["depth"] == 0)
    base = {"match_text": "FRESH MART", "account_id": cc, "category_id": cats["Dining Out / Takeout"]}
    nothing_to_match = {"match_text": "", "account_id": cc, "category_id": cats["Dining Out / Takeout"]}
    assert client.post("/api/import-rules", json=nothing_to_match).status_code == 400
    bad_section = base | {"day_from": 1, "category_id": section}
    assert client.post("/api/import-rules", json=bad_section).status_code == 400
    bad_account = {**base, "account_id": 999999, "day_from": 1}
    assert client.post("/api/import-rules", json=bad_account).status_code == 400
    # a rule with text but no date is now valid
    text_only = client.post("/api/import-rules", json=base).json()["id"]
    client.delete(f"/api/import-rules/{text_only}")

    # no history, no rules -> the merchant is uncategorized
    first = client.post("/api/import/preview", files=files, data=data).json()
    assert first[0]["category_id"] is None

    rule_id = client.post(
        "/api/import-rules", json=base | {"day_from": 1, "day_to": 5}
    ).json()["id"]
    try:
        rows = client.post("/api/import/preview", files=files, data=data).json()
        assert rows[0]["category_id"] == cats["Dining Out / Takeout"]  # assigned by the rule
        assert rows[1]["category_id"] is None  # income row doesn't match -> stays unassigned
    finally:
        client.delete(f"/api/import-rules/{rule_id}")

    # history wins over an explicit rule: once the merchant is learned, the rule is ignored
    rule_id = client.post(
        "/api/import-rules", json=base | {"day_from": 1, "day_to": 5}
    ).json()["id"]
    try:
        category_for = {"out": cats["Grocery"], "in": cats["Other Income"]}
        fields = ("date", "description", "amount_cents", "direction", "key")
        good = [{k: r[k] for k in fields} | {"category_id": category_for[r["direction"]]} for r in rows]
        assert client.post("/api/import/commit", json={"account_id": cc, "rows": good}).json() == {"imported": 2}
        again = client.post("/api/import/preview", files=files, data=data).json()
        assert again[0]["category_id"] == cats["Grocery"]  # learned, not the rule's Takeout
    finally:
        client.delete(f"/api/import-rules/{rule_id}")


def test_report_and_cashflow_shapes(client, ids):
    cats, accs = ids
    client.post("/api/transactions", json=_txn_body(cats, accs, date="2026-05-04"))
    report = client.get("/api/reports", params={"as_of": "2026-05-15"}).json()
    assert report["months"] == ["2026-03", "2026-04", "2026-05"]  # rolling window
    assert report["month"] == 3  # defaults to the last month with activity
    assert report["chart"]["categories"] == ["Dining Out / Takeout"]
    row = next(r for r in report["rows"] if r["category_id"] == cats["Dining Out / Takeout"])
    assert row["months"] == [0, 0, 3955]
    assert client.get("/api/reports", params={"as_of": "2026-05-15", "month": 2}).json()["month"] == 2

    flow = client.get("/api/cashflow", params={"account_id": accs["Chequing"]}).json()
    assert flow["account"]["name"] == "Chequing"
    assert flow["ledger"]["rows"][0]["delta_cents"] == -3955


def test_thresholds_roundtrip(client, ids):
    _, accs = ids

    def thresholds():
        ledger = client.get("/api/cashflow", params={"account_id": accs["Chequing"]}).json()["ledger"]
        return ledger["low_threshold_cents"], ledger["warn_threshold_cents"]

    original = thresholds()
    try:
        assert client.put("/api/settings/thresholds", json={"low": "10", "warn": "20.50"}).json() == {
            "low_balance_cents": 1000,
            "warn_balance_cents": 2050,
        }
        assert thresholds() == (1000, 2050)
        assert client.put("/api/settings/thresholds", json={"low": "x", "warn": "1"}).status_code == 400
        assert thresholds() == (1000, 2050)  # a rejected update changes nothing
    finally:
        client.put(
            "/api/settings/thresholds",
            json={"low": str(original[0] / 100), "warn": str(original[1] / 100)},
        )


def test_account_config_endpoints(client, db):
    cfg = client.get("/api/settings/account-config").json()
    assert [t["key"] for t in cfg["types"]] == ["bank", "cash", "savings", "investment", "debt"]
    assert cfg["types"] == [
        {"key": "bank", "label": "Bank / Chequing"},
        {"key": "cash", "label": "Cash"},
        {"key": "savings", "label": "Savings"},
        {"key": "investment", "label": "Investment"},
        {"key": "debt", "label": "Debt / loan"},
    ]
    # validated against the configured set
    made = client.post("/api/accounts", json={"name": "Savings Pot", "kind": "savings", "opening_balance": "10"})
    assert made.status_code == 201
    client.delete(f"/api/accounts/{made.json()['id']}")
    assert client.post("/api/accounts", json={"name": "x", "kind": "gold"}).status_code == 400


def test_category_config_endpoints(client, db):
    cfg = client.get("/api/settings/category-config").json()
    assert [t["key"] for t in cfg["types"]] == ["expense", "income", "savings", "debt", "investment"]
    assert {t["direction"] for t in cfg["types"]} == {"in", "out"}
    assert len(cfg["levels"]) == 4

    try:
        bad = client.put("/api/settings/category-config", json={"levels": ["Only", "Two"]})
        assert bad.status_code == 400
        res = client.put(
            "/api/settings/category-config",
            json={"levels": ["Group", "Category", "Item", "Detail"]},
        )
        assert res.status_code == 200 and res.json()["levels"][0] == "Group"
        assert client.get("/api/settings/category-config").json()["levels"][0] == "Group"
    finally:
        client.put(
            "/api/settings/category-config",
            json={"levels": ["Section", "Category", "Sub-category", "Sub-sub-category"]},
        )

    # A valid custom type works; an unknown one is rejected.
    made = client.post("/api/categories", json={"name": "Reserve", "kind": "savings"})
    assert made.status_code == 201
    client.delete(f"/api/categories/{made.json()['id']}")
    assert client.post("/api/categories", json={"name": "Nope", "kind": "weird"}).status_code == 400


@pytest.mark.skipif(not (DIST / "index.html").exists(), reason="front end not built")
def test_spa_is_served_at_the_root_with_client_side_routing_fallback(client):
    index = client.get("/")
    assert index.status_code == 200 and '<div id="root">' in index.text
    assert index.headers["cache-control"] == "no-cache"  # a rebuild must show up on the next load
    for deep_link in ("/budget", "/settings/categories", "/transactions/12"):
        assert client.get(deep_link).text == index.text, deep_link

    asset = next((DIST / "assets").glob("*.js")).name
    res = client.get(f"/assets/{asset}")
    assert res.status_code == 200 and "javascript" in res.headers["content-type"]
    assert "immutable" in res.headers["cache-control"]
    # no path traversal out of dist
    assert client.get("/..%2Fapp%2Fmain.py").text == index.text


def test_unknown_api_paths_are_404_not_the_html_page(client):
    for path in ("/api/nope", "/api"):
        res = client.get(path)
        assert res.status_code == 404 and "<html" not in res.text, path


def test_old_server_rendered_pages_are_gone(client):
    # These paths now belong to the React app: plain GETs get the SPA shell, form posts are rejected.
    assert client.post("/transactions", data={"description": "x"}).status_code == 405
    assert client.post("/categories", data={"name": "x"}).status_code == 405


def test_healthz_is_open_and_everything_else_needs_auth_when_a_password_is_set():
    from fastapi.testclient import TestClient

    from app.core.config import Settings, get_settings
    from app.main import create_app

    app = create_app()
    app.dependency_overrides[get_settings] = lambda: Settings(app_user="me", app_password="s3cret")
    guarded = TestClient(app)
    assert guarded.get("/healthz").status_code == 200
    for path in ("/api/categories", "/api/suggest?q=x", "/"):
        assert guarded.get(path).status_code == 401, path
    assert guarded.get("/api/categories", auth=("me", "wrong")).status_code == 401
    assert guarded.get("/api/categories", auth=("me", "s3cret")).status_code == 200


def test_clear_transactions_removes_rows_and_keeps_setup(client, ids):
    cats, accs = ids
    assert client.post("/api/transactions", json=_txn_body(cats, accs)).status_code == 201
    before = client.get("/api/transactions").json()["total"]
    assert before >= 1

    res = client.delete("/api/transactions")
    assert res.status_code == 200
    assert res.json()["deleted"] == before
    assert client.get("/api/transactions").json()["total"] == 0

    # Setup survives a clear.
    assert client.get("/api/categories").status_code == 200
    assert client.get("/api/accounts").status_code == 200


def test_clear_transactions_imported_only_keeps_hand_entered(client, ids, db):
    cats, accs = ids
    client.post("/api/transactions", json=_txn_body(cats, accs, description="Manual entry"))
    db.add(
        Transaction(
            date=date(2026, 5, 4),
            description="Imported row",
            category_id=cats["Dining Out / Takeout"],
            account_id=accs["Chequing"],
            amount_cents=100,
            import_hash="clear-test-hash",
        )
    )
    db.commit()

    res = client.delete("/api/transactions", params={"imported_only": "true"})
    assert res.status_code == 200
    assert res.json()["deleted"] == 1

    descriptions = [t["description"] for t in client.get("/api/transactions").json()["items"]]
    assert "Manual entry" in descriptions
    assert "Imported row" not in descriptions

