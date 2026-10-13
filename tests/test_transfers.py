"""Account-to-account transfers: two linked legs, excluded from budgets and reports."""

from __future__ import annotations


def _transfer_body(accs, **overrides):
    return {
        "date": "2026-05-04",
        "description": "To savings",
        "amount": "250",
        "from_account_id": accs["Chequing"],
        "to_account_id": accs["Savings"],
        "notes": "",
    } | overrides


def _balances(client):
    return {a["id"]: a["current_balance_cents"] for a in client.get("/api/accounts").json()}


def test_create_transfer_moves_money_between_accounts(client, ids):
    _, accs = ids
    res = client.post("/api/transfers", json=_transfer_body(accs))
    assert res.status_code == 201
    transfer_id = res.json()["transfer_id"]

    balances = _balances(client)
    assert balances[accs["Chequing"]] == -25000
    assert balances[accs["Savings"]] == 25000

    legs = [t for t in client.get("/api/transactions").json()["items"] if t["transfer_id"] == transfer_id]
    assert len(legs) == 2
    assert sorted(t["amount_cents"] for t in legs) == [-25000, 25000]
    # each leg knows the other account, so the list can render both sides
    out_leg = next(t for t in legs if t["account_id"] == accs["Chequing"])
    assert out_leg["transfer_account_name"] == "Savings"
    in_leg = next(t for t in legs if t["account_id"] == accs["Savings"])
    assert in_leg["transfer_account_name"] == "Chequing"

    # the hidden system category never surfaces in the picker feed
    assert all(c["kind"] != "transfer" for c in client.get("/api/categories").json())

    # transfers are neither income nor expense: budgets and reports ignore them
    budget = client.get("/api/budget", params={"month": "2026-05"}).json()
    assert budget["expense_actual"] == 0 and budget["income_actual"] == 0
    report = client.get("/api/reports", params={"as_of": "2026-05-15"}).json()
    assert report["net_months"] == [0, 0, 0]
    assert report["chart"]["spending"] == [0, 0, 0] and report["chart"]["income"] == [0, 0, 0]

    # deleting one leg removes the pair
    assert client.delete(f"/api/transactions/{out_leg['id']}").status_code == 204
    assert [t for t in client.get("/api/transactions").json()["items"] if t["transfer_id"] == transfer_id] == []


def test_create_transfer_validates_accounts_and_amount(client, ids):
    _, accs = ids
    same = client.post("/api/transfers", json=_transfer_body(accs, to_account_id=accs["Chequing"]))
    assert same.status_code == 400 and "different accounts" in same.json()["detail"]
    zero = client.post("/api/transfers", json=_transfer_body(accs, amount="0"))
    assert zero.status_code == 400 and "greater than zero" in zero.json()["detail"]
    missing = client.post("/api/transfers", json=_transfer_body(accs, to_account_id=None))
    assert missing.status_code == 400 and "both accounts" in missing.json()["detail"]


def test_connect_two_imported_rows(client, ids):
    cats, accs = ids
    out = client.post(
        "/api/transactions",
        json={
            "date": "2026-05-04",
            "description": "TRANSFER TO SAV",
            "category_id": cats["Grocery"],
            "account_id": accs["Chequing"],
            "amount": "250",
            "notes": "",
        },
    ).json()
    inc = client.post(
        "/api/transactions",
        json={
            "date": "2026-05-05",
            "description": "TRANSFER FROM CHEQ",
            "category_id": cats["Other Income"],
            "account_id": accs["Savings"],
            "amount": "250",
            "notes": "",
        },
    ).json()

    res = client.post("/api/transfers/connect", json={"from_id": out["id"], "to_id": inc["id"]})
    assert res.status_code == 200
    transfer_id = res.json()["transfer_id"]

    balances = _balances(client)
    assert balances[accs["Chequing"]] == -25000
    assert balances[accs["Savings"]] == 25000

    listed = {t["id"]: t for t in client.get("/api/transactions").json()["items"]}
    assert listed[out["id"]]["amount_cents"] == -25000
    assert listed[inc["id"]]["amount_cents"] == 25000
    assert listed[out["id"]]["transfer_id"] == transfer_id

    # both legs no longer count as spending/income
    assert client.get("/api/budget", params={"month": "2026-05"}).json()["expense_actual"] == 0


def test_connect_rejects_invalid_pairs(client, ids):
    cats, accs = ids

    def make(description, category, account, amount, when="2026-05-04"):
        return client.post(
            "/api/transactions",
            json={
                "date": when,
                "description": description,
                "category_id": category,
                "account_id": account,
                "amount": amount,
                "notes": "",
            },
        ).json()

    a = make("A out", cats["Grocery"], accs["Chequing"], "100")
    b = make("B out", cats["Grocery"], accs["Savings"], "100")  # also money out
    c = make("C in", cats["Other Income"], accs["Savings"], "100")
    wrong_amount = make("D in", cats["Other Income"], accs["Savings"], "60")

    same_direction = client.post("/api/transfers/connect", json={"from_id": a["id"], "to_id": b["id"]})
    assert same_direction.status_code == 400 and "money out" in same_direction.json()["detail"]
    mismatch = client.post("/api/transfers/connect", json={"from_id": a["id"], "to_id": wrong_amount["id"]})
    assert mismatch.status_code == 400

    assert client.post("/api/transfers/connect", json={"from_id": a["id"], "to_id": c["id"]}).status_code == 200
    # a row can only belong to one transfer
    again = client.post("/api/transfers/connect", json={"from_id": a["id"], "to_id": wrong_amount["id"]})
    assert again.status_code == 400 and "already" in again.json()["detail"]


def test_update_and_delete_transfer(client, ids):
    _, accs = ids
    transfer_id = client.post("/api/transfers", json=_transfer_body(accs)).json()["transfer_id"]

    got = client.get(f"/api/transfers/{transfer_id}").json()
    assert got["amount_cents"] == 25000
    assert got["from_account_id"] == accs["Chequing"] and got["to_account_id"] == accs["Savings"]

    res = client.put(
        f"/api/transfers/{transfer_id}",
        json=_transfer_body(
            accs,
            amount="300",
            description="Moved",
            from_account_id=accs["Savings"],
            to_account_id=accs["Cash"],
        ),
    )
    assert res.status_code == 200
    balances = _balances(client)
    assert balances[accs["Savings"]] == -30000
    assert balances[accs["Cash"]] == 30000
    assert balances[accs["Chequing"]] == 0

    legs = [t for t in client.get("/api/transactions").json()["items"] if t["transfer_id"] == transfer_id]
    assert all(t["description"] == "Moved" for t in legs)

    # delete via either leg removes both
    assert client.delete(f"/api/transactions/{legs[0]['id']}").status_code == 204
    assert client.get(f"/api/transfers/{transfer_id}").status_code == 400
