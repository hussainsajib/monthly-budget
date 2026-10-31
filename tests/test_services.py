from datetime import date

import pytest

from app.models import Account, ImportRule, Transaction
from app.services import cashflow, import_rules, importing, reports, suggestions
from app.services import categories as category_service


def _add(db, cat, cents, when, desc="x", acc=None):
    t = Transaction(date=when, description=desc, category_id=cat, account_id=acc, amount_cents=cents)
    db.add(t)
    db.commit()
    return t


def test_report_rolls_up_children_and_ignores_future(db, ids):
    cats, _ = ids
    costco = category_service.create_category(db, "Costco", cats["Grocery"], budget_cents=20000)
    try:
        _add(db, costco.id, 10000, date(2026, 5, 3))
        _add(db, cats["Grocery"], 5000, date(2026, 5, 4))
        _add(db, cats["Grocery"], 7000, date(2026, 6, 4))
        _add(db, cats["Grocery"], 9999, date(2026, 12, 30))  # planned: outside the window
        report = reports.budget_report(db, as_of=date(2026, 6, 30))
        row = {r.name: r for r in report.rows}
        assert report.months == ["2026-04", "2026-05", "2026-06"]  # rolling 3 months
        assert row["Grocery"].months[1] == 15000  # own + Costco, in May
        assert row["Costco"].months[1] == 10000
        assert row["Grocery"].months[2] == 7000
        assert row["Grocery"].months[0] == 0
        assert report.active == [1, 2]
        assert row["Grocery"].avg == 11000
        assert row["Essential Variable"].total == 22000
        assert row["Grocery"].budget == 20000  # sum of children
    finally:
        db.query(Transaction).delete()
        db.commit()
        category_service.delete_category(db, costco.id)


def test_report_window_rolls_and_clips_the_current_month(db, ids):
    cats, _ = ids
    _add(db, cats["Grocery"], 4000, date(2026, 12, 8))
    _add(db, cats["Grocery"], 1000, date(2027, 1, 5))
    _add(db, cats["Grocery"], 2000, date(2027, 1, 25))  # future-dated: excluded
    report = reports.budget_report(db, as_of=date(2027, 1, 10))
    assert report.months == ["2026-11", "2026-12", "2027-01"]
    row = next(r for r in report.rows if r.name == "Grocery")
    assert row.months == [0, 4000, 1000]


def test_income_counts_toward_net(db, ids):
    cats, _ = ids
    _add(db, cats["Salary (net)"], 300000, date(2026, 5, 1))
    _add(db, cats["Rent"], 100000, date(2026, 5, 2))
    report = reports.budget_report(db, as_of=date(2026, 5, 31))
    assert report.net_months[2] == 200000  # May is the last month of the window


def test_cashflow_running_balance_and_planned(db, ids):
    cats, accs = ids
    acc = db.get(Account, accs["Chequing"])
    acc.opening_balance_cents, acc.opening_date = 100000, date(2026, 5, 1)
    db.commit()
    try:
        _add(db, cats["Rent"], 80000, date(2026, 5, 2), acc=acc.id)
        _add(db, cats["Salary (net)"], 50000, date(2026, 5, 10), acc=acc.id)
        _add(db, cats["Grocery"], 20000, date(2026, 6, 1), acc=acc.id)  # planned
        _add(db, cats["Grocery"], 99999, date(2026, 5, 5), acc=accs["Credit Card"])  # other account
        ledger = cashflow.build_ledger(db, acc, today=date(2026, 5, 15))
        assert [r.balance_cents for r in ledger.rows] == [20000, 70000, 50000]
        assert ledger.current_balance_cents == 70000
        assert ledger.projected_balance_cents == 50000
        assert ledger.rows[0].level == "low"  # 200.00 < 500.00 default alert
        assert ledger.rows[2].is_planned
        assert ledger.lowest.balance_cents == 20000
    finally:
        acc.opening_balance_cents, acc.opening_date = 0, None
        db.commit()


def test_recurring_lands_in_separate_budget_slot(db):
    from app.services import budgets

    rent = next(line for line in budgets.build_month(db, date(2026, 2, 1)).lines if line.name == "Rent")
    assert rent.recurring_cents == 150000  # seeded Rent recurring, once a month
    assert rent.budget_cents == rent.default_cents  # recurring is shown separately, not folded into budget
    assert rent.actual_cents == 0
    assert db.query(Transaction).filter(Transaction.date.between(date(2026, 2, 1), date(2026, 2, 28))).count() == 0


def test_import_rule_matches_any_pipe_phrase(db, ids):
    cats, accs = ids
    rule = ImportRule(
        match_text="NETFLIX | SPOTIFY | Disney+",
        account_id=accs["Credit Card"],
        category_id=cats["Grocery"],
    )
    db.add(rule)
    db.commit()
    try:
        rules = [rule]
        assert import_rules.match(rules, "SPOTIFY AB123", accs["Credit Card"], date(2026, 5, 3)) == cats["Grocery"]
        assert import_rules.match(rules, "Disney+ monthly", accs["Credit Card"], date(2026, 5, 3)) == cats["Grocery"]
        assert import_rules.match(rules, "Amazon Prime", accs["Credit Card"], date(2026, 5, 3)) is None
        assert import_rules.match(rules, "NETFLIX", accs["Chequing"], date(2026, 5, 3)) is None  # wrong account
    finally:
        db.delete(rule)
        db.commit()


def test_suggestions_exact_and_noisy_match(db, ids):
    cats, accs = ids
    _add(db, cats["Grocery"], 7400, date(2026, 5, 1), desc="Fresh Mart", acc=accs["Chequing"])
    index = suggestions.build_index(db)
    assert suggestions.lookup(index, "fresh mart").category_id == cats["Grocery"]
    assert suggestions.lookup(index, "FRESH MART #123 ANYTOWN ON").account_id == accs["Chequing"]
    assert suggestions.lookup(index, "Unknown shop") is None


TD_CSV = b"2026-05-02,FRESH MART #1,74.00,,5000.00\n2026-05-03,PAYROLL,,3500.00,8500.00\n"


def test_csv_parse_headerless_td_and_directions():
    rows = importing.parse_csv(TD_CSV)
    assert [(r.description, r.amount_cents, r.direction) for r in rows] == [
        ("FRESH MART #1", 7400, "out"),
        ("PAYROLL", 350000, "in"),
    ]


def test_csv_parse_header_with_signed_amount():
    csv = b"Date,Description,Amount\n05/02/2026,Coffee,4.50\n05/03/2026,Refund,-10.00\n"
    out = importing.parse_csv(csv, positive_is_expense=True)
    assert [(r.date, r.direction) for r in out] == [(date(2026, 5, 2), "out"), (date(2026, 5, 3), "in")]


def test_csv_import_flags_duplicates_and_is_idempotent(db, ids):
    cats, accs = ids
    acc = accs["Chequing"]
    _add(db, cats["Grocery"], 7400, date(2026, 4, 1), desc="Fresh Mart", acc=acc)
    rows = importing.prepare_preview(db, importing.parse_csv(TD_CSV), acc)
    assert rows[0].category_id == cats["Grocery"]  # learned from history
    assert not rows[0].duplicate
    rows[1].category_id = cats["Salary (net)"]
    assert importing.commit_rows(db, rows, acc) == 2
    again = importing.prepare_preview(db, importing.parse_csv(TD_CSV), acc)
    assert all(r.duplicate for r in again)  # same hashes -> flagged
    assert importing.commit_rows(db, again, acc) == 0  # existing hashes are skipped, not re-inserted
    salary = db.query(Transaction).filter_by(description="PAYROLL").one()
    assert salary.amount_cents == 350000  # money in on an income category stays positive


def test_refund_on_expense_category_is_negative(db, ids):
    cats, _ = ids
    row = importing.ParsedRow(date(2026, 5, 3), "Refund", 1000, "in", category_id=cats["Grocery"], key="k1")
    importing.commit_rows(db, [row], None)
    assert db.query(Transaction).filter_by(import_hash="k1").one().amount_cents == -1000


def _loan_rule_setup(db, accs):
    loan = Account(name="Test Loan", kind="debt", opening_balance_cents=-100000, opening_date=date(2026, 1, 1))
    db.add(loan)
    db.commit()
    rule = import_rules.create_rule(
        db, "E-TFR ***T4m", accs["Chequing"], None, amount_cents=80000, loan_account_id=loan.id
    )
    return loan, rule


def _loan_rule_cleanup(db, loan, rule):
    db.query(Transaction).delete()
    db.delete(rule)
    db.delete(loan)
    db.commit()


def test_loan_rule_forces_transfer_category_and_claims_money_out_rows(db, ids):
    _, accs = ids
    loan, rule = _loan_rule_setup(db, accs)
    try:
        assert rule.category.kind == "transfer"
        rows = [
            importing.ParsedRow(date(2026, 3, 1), "SEND E-TFR ***T4m", 80000, "out"),
            importing.ParsedRow(date(2026, 3, 1), "SEND E-TFR ***T4m", 80000, "in"),
            importing.ParsedRow(date(2026, 3, 1), "SEND E-TFR ***T4m", 5000, "out"),
        ]
        importing.prepare_preview(db, rows, accs["Chequing"])
        assert [r.loan_account_id for r in rows] == [loan.id, None, None]
    finally:
        _loan_rule_cleanup(db, loan, rule)


def test_loan_rule_rejects_a_non_loan_target(db, ids):
    _, accs = ids
    other = Account(name="Test Savings", kind="bank")
    db.add(other)
    db.commit()
    try:
        with pytest.raises(import_rules.RuleError):
            import_rules.create_rule(db, "X", accs["Chequing"], None, loan_account_id=other.id)
    finally:
        db.delete(other)
        db.commit()


def test_commit_turns_a_loan_rule_row_into_one_payment_not_two(db, ids):
    _, accs = ids
    loan, rule = _loan_rule_setup(db, accs)
    try:
        rows = [importing.ParsedRow(date(2026, 3, 1), "SEND E-TFR ***T4m", 80000, "out", balance_cents=5)]
        importing.prepare_preview(db, rows, accs["Chequing"])
        assert importing.commit_rows(db, rows, accs["Chequing"]) == 1
        legs = list(db.query(Transaction).order_by(Transaction.id))
        assert [(t.account_id, t.amount_cents, t.link_kind) for t in legs] == [
            (accs["Chequing"], -80000, "transfer"),
            (loan.id, 80000, "transfer"),
        ]
        assert legs[0].import_hash is not None and legs[0].link_id == legs[1].link_id
        assert legs[0].balance_cents == 5
    finally:
        _loan_rule_cleanup(db, loan, rule)


def test_apply_rules_lets_a_loan_rule_override_a_history_category(db, ids):
    cats, accs = ids
    loan, rule = _loan_rule_setup(db, accs)
    try:
        rows = [importing.ParsedRow(date(2026, 3, 1), "SEND E-TFR ***T4m", 80000, "out", category_id=cats["Grocery"])]
        importing.apply_rules(db, rows, accs["Chequing"])
        assert rows[0].loan_account_id == loan.id and rows[0].category_id == rule.category_id
    finally:
        _loan_rule_cleanup(db, loan, rule)
