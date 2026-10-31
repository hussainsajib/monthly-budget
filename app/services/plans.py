"""Plans: hypothetical future projections derived from real data, never written to the ledger.

A plan has a ``type`` (see ``app.services.plan_types``) and a JSON ``config``. ``PlanItem`` rows are
the user's manual adjustments layered on top of the derived projection. The engine reads recurring
templates, transactions and account balances to build each plan's view; nothing here mutates the
ledger except CRUD on the plan tables themselves.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.money import to_cents
from app.models import INCOME, TRANSFER, Account, Category, Plan, PlanItem, RecurringTemplate, Transaction
from app.models.ledger import direction_effect, direction_of
from app.services import budgets, plan_types
from app.services.cashflow import balance_at, build_ledger
from app.services.categories import load_tree
from app.services.category_config import income_keys
from app.services.events import LEDGER, MANUAL, RECURRING, event_stream, manual_events, recurring_events, to_public

MATCH_WINDOW_DAYS = 5
DEFAULT_LOOKAHEAD = 2
MAX_LOOKAHEAD = 6
HORIZON_DAYS = 180  # how far ahead to look for paychecks
NO_PAYCHECK_FALLBACK_DAYS = 60
MAX_PAYOFF_MONTHS = 600
MAX_SAVINGS_MONTHS = 120  # a savings window is walked month by month; cap it so a bad date can't loop forever


class PlanError(ValueError):
    """A plan operation violated a business rule (shown to the user)."""


# ------------------------------------------------------------------- config


def normalize_config(plan_type: plan_types.PlanType, raw: dict | None) -> dict:
    """Coerce a raw (API) config into stored form: money -> cents, dates validated, known keys only."""
    raw = raw or {}
    out: dict = {}
    for spec in plan_type.config_fields:
        value = raw.get(spec.key)
        if spec.kind == "money":
            out[spec.key] = to_cents(value) if value not in (None, "") else 0
        elif spec.kind == "int":
            try:
                out[spec.key] = int(value) if value not in (None, "") else 0
            except (TypeError, ValueError) as exc:
                raise PlanError(f"{spec.label} must be a whole number") from exc
        elif spec.kind == "date":
            if value in (None, ""):
                out[spec.key] = None
            else:
                try:
                    out[spec.key] = date.fromisoformat(str(value)).isoformat()
                except ValueError as exc:
                    raise PlanError(f"{spec.label} must be a valid date") from exc
        elif spec.kind == "select":
            allowed = {k for k, _ in spec.options}
            out[spec.key] = value if value in allowed else (spec.options[0][0] if spec.options else None)
        elif spec.kind == "categories":
            out[spec.key] = []
            for item in value if isinstance(value, list) else []:
                try:
                    out[spec.key].append(int(item))
                except (TypeError, ValueError):
                    continue
        elif spec.kind in ("category", "paycheck", "loan"):
            out[spec.key] = int(value) if value not in (None, "") else None
        else:
            out[spec.key] = str(value).strip() if value not in (None, "") else ""
    return out


# --------------------------------------------------------------------- CRUD


def _clean_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise PlanError("Name is required")
    return name[:80]


def list_plans(db: Session) -> list[Plan]:
    return list(db.scalars(select(Plan).order_by(Plan.sort_order, Plan.id)))


def get_plan(db: Session, plan_id: int) -> Plan:
    plan = db.get(Plan, plan_id)
    if plan is None:
        raise PlanError("Plan not found")
    return plan


def _validate_account(db: Session, account_id: int | None) -> None:
    if account_id is not None and db.get(Account, account_id) is None:
        raise PlanError("Account not found")


def _validate_paycheck(db: Session, plan_type: plan_types.PlanType, config: dict) -> None:
    """A rolling plan's paycheck must point at an existing recurring income template."""
    if plan_type.key != "rolling":
        return
    template_id = config.get("paycheck_id")
    if template_id is None:
        return
    template = db.get(RecurringTemplate, template_id)
    if template is None:
        raise PlanError("Paycheck not found")
    kind = template.category.kind if template.category else "expense"
    if kind not in income_keys(db):
        raise PlanError("The selected paycheck must be a recurring income")


def create_plan(
    db: Session,
    *,
    name: str,
    type: str,
    account_id: int | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    notes: str = "",
    config: dict | None = None,
) -> Plan:
    plan_type = plan_types.get_type(type)
    _validate_account(db, account_id)
    normalized = normalize_config(plan_type, config)
    _validate_paycheck(db, plan_type, normalized)
    next_sort = (db.scalar(select(func.max(Plan.sort_order))) or 0) + 10
    plan = Plan(
        name=_clean_name(name),
        type=plan_type.key,
        status="active",
        account_id=account_id,
        start_date=start_date,
        end_date=end_date,
        notes=(notes or "").strip(),
        sort_order=next_sort,
        config=normalized,
    )
    db.add(plan)
    db.commit()
    return plan


def update_plan(
    db: Session,
    plan: Plan,
    *,
    name: str,
    account_id: int | None,
    start_date: date | None,
    end_date: date | None,
    notes: str,
    status: str,
    config: dict | None,
) -> Plan:
    plan_type = plan_types.get_type(plan.type)
    _validate_account(db, account_id)
    if status not in ("active", "archived", "done"):
        raise PlanError("Invalid status")
    normalized = normalize_config(plan_type, config)
    _validate_paycheck(db, plan_type, normalized)
    plan.name = _clean_name(name)
    plan.account_id = account_id
    plan.start_date = start_date
    plan.end_date = end_date
    plan.notes = (notes or "").strip()
    plan.status = status
    plan.config = normalized
    db.commit()
    return plan


def delete_plan(db: Session, plan: Plan) -> None:
    db.delete(plan)
    db.commit()


def _item_kind(plan_type: plan_types.PlanType, item_kind: str) -> str:
    return item_kind if item_kind in plan_type.item_kinds else plan_type.item_kinds[0]


def create_item(db: Session, plan: Plan, **fields) -> PlanItem:
    plan_type = plan_types.get_type(plan.type)
    next_sort = (db.scalar(select(func.max(PlanItem.sort_order)).where(PlanItem.plan_id == plan.id)) or 0) + 10
    direction = fields.get("direction") if fields.get("direction") in ("in", "out") else "out"
    item = PlanItem(
        plan_id=plan.id,
        date=fields.get("date"),
        description=(fields.get("description") or "").strip()[:200],
        category_id=fields.get("category_id"),
        account_id=fields.get("account_id"),
        amount_cents=direction_effect(abs(int(fields.get("amount_cents") or 0)), direction),
        item_kind=_item_kind(plan_type, fields.get("item_kind") or "custom"),
        source="manual",
        sort_order=next_sort,
    )
    db.add(item)
    db.commit()
    return item


def update_item(db: Session, item: PlanItem, **fields) -> PlanItem:
    plan_type = plan_types.get_type(item.plan.type)
    if "matched_transaction_id" in fields:
        txn_id = fields.get("matched_transaction_id")
        if txn_id is not None and db.get(Transaction, txn_id) is None:
            raise PlanError("Transaction not found")
        item.matched_transaction_id = txn_id
    if "description" in fields:
        item.description = (fields.get("description") or "").strip()[:200]
    if "date" in fields:
        item.date = fields.get("date")
    if "category_id" in fields:
        item.category_id = fields.get("category_id")
    if "account_id" in fields:
        item.account_id = fields.get("account_id")
    if "amount_cents" in fields or "direction" in fields:
        # The API still speaks magnitude + direction; the row keeps the signed effect.
        direction = (
            fields["direction"] if fields.get("direction") in ("in", "out") else direction_of(item.amount_cents)
        )
        magnitude = abs(int(fields["amount_cents"])) if "amount_cents" in fields else abs(item.amount_cents)
        item.amount_cents = direction_effect(magnitude, direction)
    if "item_kind" in fields:
        item.item_kind = _item_kind(plan_type, fields.get("item_kind") or "custom")
    db.commit()
    return item


def get_item(db: Session, item_id: int) -> PlanItem:
    item = db.get(PlanItem, item_id)
    if item is None:
        raise PlanError("Plan item not found")
    return item


def delete_item(db: Session, item: PlanItem) -> None:
    db.delete(item)
    db.commit()


# --------------------------------------------------------------- derivation


def _config(plan: Plan) -> dict:
    return plan.config or {}


def _paychecks(db: Session, start: date, lookahead: int, template_id: int | None = None) -> list[date]:
    horizon = start + timedelta(days=HORIZON_DAYS)
    events = recurring_events(db, start, horizon, income_only=True)
    if template_id is not None:
        events = [e for e in events if e["ref_id"] == template_id]
    dates = sorted({e["date"] for e in events})
    return dates[:lookahead]


def _variable_spending(db: Session, config: dict, start: date, end: date) -> int:
    """Budgeted-but-unscheduled spending (groceries, fuel, …) across the window.

    Sums the selected leaf categories' default monthly budgets and multiplies by the number of
    calendar months the window spans — budgets are monthly, so a longer window is simply more
    months of spending.
    """
    ids = config.get("variable_category_ids") or []
    if not ids:
        return 0
    total = db.scalar(select(func.sum(Category.monthly_budget_cents)).where(Category.id.in_(ids))) or 0
    months = (end.year - start.year) * 12 + (end.month - start.month) + 1
    return int(total) * months


def _inflow(events: list[dict]) -> int:
    """Money in, read straight off the signed amounts."""
    return sum(e["amount_cents"] for e in events if e["amount_cents"] > 0)


def _outflow(events: list[dict]) -> int:
    """Money out as a positive number, read straight off the signed amounts."""
    return -sum(e["amount_cents"] for e in events if e["amount_cents"] < 0)


def _apply_balance(events: list[dict], opening_cents: int) -> list[dict]:
    balance = opening_cents
    for event in events:
        balance += event["amount_cents"]
        event["balance_cents"] = balance
    return events


def _attach_balances(db: Session, plan: Plan, events: list[dict]) -> list[dict]:
    """Give every event the projected balance of its target account after the row."""
    if not events:
        return events

    account = db.get(Account, plan.account_id) if plan.account_id else None
    if account is not None:
        return _apply_balance(events, build_ledger(db, account).current_balance_cents)

    balances: dict[int, int] = {}
    for event in events:
        account_id = event.get("account_id")
        event_account = db.get(Account, account_id) if account_id else None
        if event_account is None:
            event["balance_cents"] = None
            continue
        if event_account.id not in balances:
            balances[event_account.id] = build_ledger(db, event_account).current_balance_cents
        balances[event_account.id] += event["amount_cents"]
        event["balance_cents"] = balances[event_account.id]
    return events


def _sort_events(events: list[dict]) -> None:
    events.sort(
        key=lambda e: (
            e["date"] is None,
            e["date"] or date.max,
            e["source"] != "manual",
        )
    )


def derive_rolling(db: Session, plan: Plan, tree) -> dict:
    config = _config(plan)
    today = date.today()
    start = plan.start_date or today
    lookahead = min(max(int(config.get("lookahead_paychecks") or DEFAULT_LOOKAHEAD), 1), MAX_LOOKAHEAD)
    buffer_cents = int(config.get("buffer_cents") or 0)
    paycheck_id = config.get("paycheck_id")
    paycheck = db.get(RecurringTemplate, paycheck_id) if paycheck_id else None
    if paycheck is None:
        paycheck_id = None

    paychecks = _paychecks(db, start, lookahead, paycheck_id)
    end = plan.end_date or (paychecks[-1] if paychecks else start + timedelta(days=NO_PAYCHECK_FALLBACK_DAYS))

    account = db.get(Account, plan.account_id) if plan.account_id else None

    # Forward-looking events drive the summary numbers (safe-to-spend, end balance). Rows dated today
    # or earlier are already inside ``opening`` below, so the projection starts after them.
    summary_events = event_stream(
        db, start=start, end=end, plan=plan, tree=tree, account_id=plan.account_id, after=today
    )
    summary_events.sort(key=lambda e: (e["date"] or start, e["source"] != "manual"))

    opening = build_ledger(db, account).current_balance_cents if account else 0
    _apply_balance(summary_events, opening)

    inflow = _inflow(summary_events)
    outflow = _outflow(summary_events)
    variable = _variable_spending(db, config, start, end)
    lowest = min((e["balance_cents"] for e in summary_events), default=opening)

    # The window the user sees also spans the current month's already-passed dates, so a scheduled
    # expense whose day has gone by still shows up - matched to the transaction that recorded it, or
    # left "planned" when no such transaction exists yet. Income occurrences stay forward-looking;
    # past income shows as the real transactions that recorded it.
    window_start = plan.start_date or date(today.year, today.month, 1)
    planned = event_stream(
        db, start=start, end=end, sources=(RECURRING,), tree=tree, income_only=True
    )
    planned += event_stream(
        db, start=window_start, end=end, sources=(RECURRING,), tree=tree, income_only=False
    )
    planned += event_stream(db, start=start, end=end, sources=(MANUAL,), plan=plan, tree=tree)
    planned = _drift(db, planned)
    matched_ids = {e["matched_transaction_id"] for e in planned if e.get("matched_transaction_id")}
    leftovers = [
        e
        for e in event_stream(
            db, start=window_start, end=end, sources=(LEDGER,), account_id=plan.account_id, tree=tree
        )
        if e["matched_transaction_id"] not in matched_ids
    ]
    for e in leftovers:
        e["actual_cents"] = e["amount_cents"]
        e["variance_cents"] = 0
    window_events = planned + leftovers
    _sort_events(window_events)
    opening_window = balance_at(db, account, window_start - timedelta(days=1)) if account else 0
    _apply_balance(window_events, opening_window)

    return {
        "kind": "rolling",
        "window": {"start": window_start.isoformat(), "end": end.isoformat()},
        "lookahead_paychecks": lookahead,
        "paycheck": (
            {
                "id": paycheck.id,
                "description": paycheck.description,
                "amount_cents": abs(paycheck.amount_cents),
            }
            if paycheck
            else None
        ),
        "paychecks": [{"date": d.isoformat()} for d in paychecks],
        "opening_balance_cents": opening,
        "inflow_cents": inflow,
        "outflow_cents": outflow,
        "net_cents": inflow - outflow,
        "variable_spending_cents": variable,
        "variable_category_count": len(config.get("variable_category_ids") or []),
        "buffer_cents": buffer_cents,
        "safe_to_spend_cents": inflow - outflow - variable - buffer_cents,
        "end_balance_cents": summary_events[-1]["balance_cents"] if summary_events else opening,
        "lowest_balance_cents": lowest,
        "headline_cents": inflow - outflow - variable - buffer_cents,
        "events": window_events,
    }


def _funding(
    db: Session, plan: Plan, tree, category_id: int | None, start: date, loan_account_id: int | None = None
) -> tuple[int, dict]:
    """Net funding progress from a category's (or a loan's) transactions, with a per-transaction activity list.

    With ``loan_account_id`` the source is that loan's own ledger instead of a category: a payment
    is the transfer leg that lands on the loan, so it counts as a contribution however the paying
    row was categorised.

    Each transaction is read as a signed effect on its own account (``cash_delta_cents``). Money
    moving *toward* the plan's target account is a contribution; money moving *away* is spending, so
    a funding category that is also spent from nets down rather than inflating progress. Without a
    target account there is no reference point, so every transaction counts as a contribution.
    """
    loan = db.get(Account, loan_account_id) if loan_account_id else None
    cat = db.get(Category, category_id) if category_id else None
    is_income = bool(cat and cat.kind == INCOME)
    if loan is not None:
        target = loan.id
        where = Transaction.account_id == loan.id
    else:
        target = plan.account_id
        where = Transaction.category_id == category_id
    txns = list(
        db.scalars(
            select(Transaction).where(where, Transaction.date >= start).order_by(Transaction.date, Transaction.id)
        ).unique()
    )
    rows: list[dict] = []
    in_cents = out_cents = 0
    for t in txns:
        delta = t.cash_delta_cents(is_income)
        if target is None:
            signed = abs(delta)
        elif t.account_id == target:
            signed = delta
        else:
            signed = -delta
        if signed >= 0:
            in_cents += signed
        else:
            out_cents += -signed
        rows.append(
            {
                "id": t.id,
                "date": t.date.isoformat(),
                "description": t.description,
                "account_id": t.account_id,
                "account_name": t.account.name if t.account else None,
                "amount_cents": t.amount_cents,
                "direction": "in" if signed >= 0 else "out",
                "signed_cents": signed,
            }
        )
    block = {
        "category_id": category_id or 0,
        "category_path": f"Payments to {loan.name}" if loan is not None else tree.path(category_id),
        "account_id": target,
        "account_name": loan.name if loan is not None else (plan.account.name if plan.account else None),
        "in_cents": in_cents,
        "out_cents": out_cents,
        "net_cents": in_cents - out_cents,
        "transactions": rows,
    }
    return in_cents - out_cents, block


def derive_goal(db: Session, plan: Plan, tree) -> dict:
    config = _config(plan)
    target = int(config.get("target_cents") or 0)
    target_date_raw = config.get("target_date")
    target_date = date.fromisoformat(target_date_raw) if target_date_raw else None
    start = plan.start_date or date.today()

    funded = 0
    funding_block = None
    funding_category = config.get("category_id")
    funding_loan = config.get("loan_account_id")
    if funding_category or funding_loan:
        net, funding_block = _funding(db, plan, tree, funding_category, start, funding_loan)
        funded += net
    funded += sum(e["amount_cents"] for e in manual_events(plan, tree) if e["item_kind"] == "contribution")

    remaining = max(target - funded, 0)
    months = _months_between(date.today(), target_date) if target_date else None
    required_monthly = (remaining + months - 1) // months if months else None
    progress = round(funded / target * 100, 1) if target else 0.0

    return {
        "kind": "goal",
        "target_cents": target,
        "funded_cents": funded,
        "remaining_cents": remaining,
        "progress_pct": progress,
        "target_date": target_date.isoformat() if target_date else None,
        "months_remaining": months,
        "required_monthly_cents": required_monthly,
        "funding": funding_block,
        "headline_cents": funded,
        "headline_pct": progress,
    }


def _months_between(start: date, end: date) -> int:
    if end <= start:
        return 0
    return (end.year - start.year) * 12 + (end.month - start.month) + (1 if end.day > start.day else 0)


def _next_month(month: date) -> date:
    return date(month.year + 1, 1, 1) if month.month == 12 else date(month.year, month.month + 1, 1)


def derive_savings(db: Session, plan: Plan, tree) -> dict:
    """Project a savings plan across every month from the start date to the target date.

    Each month is either *actual* (it has fully passed, so real income and spending are known) or
    *projected* (the current month and anything ahead, which use the month's budget as the best
    estimate of what will happen). Summing month-by-month gives the free cash flow across the
    window - the money that could be set aside - while the per-category budget-vs-actual table only
    draws on elapsed months, since a future month has no spending to compare against yet. The target
    maths (funded / remaining / needed-per-month) is the goal plan's, unchanged.
    """
    config = _config(plan)
    target = int(config.get("target_cents") or 0)
    target_date_raw = config.get("target_date")
    target_date = date.fromisoformat(target_date_raw) if target_date_raw else None

    today = date.today()
    current_month = today.replace(day=1)
    created = plan.created_at.date() if plan.created_at else today
    start = plan.start_date or created
    start_month = start.replace(day=1)
    # Without a target date there is nothing to project forward to, so the window ends this month.
    end_month = (target_date or today).replace(day=1)
    if end_month < start_month:
        end_month = start_month

    income = income_keys(db)
    months: list[dict] = []
    categories: dict[int, dict] = {}
    cumulative = 0
    cursor = start_month
    for _ in range(MAX_SAVINGS_MONTHS):
        if cursor > end_month:
            break
        data = budgets.build_month(db, cursor)
        is_actual = cursor < current_month
        flow_in = data.income_actual if is_actual else data.income_budget
        flow_out = data.expense_actual if is_actual else data.expense_budget
        net = flow_in - flow_out
        cumulative += net
        months.append(
            {
                "month": cursor.isoformat()[:7],
                "kind": "actual" if is_actual else "projected",
                "income_cents": flow_in,
                "expense_cents": flow_out,
                "net_cents": net,
                "cumulative_cents": cumulative,
            }
        )
        if is_actual:
            for line in data.lines:
                if line.kind in income:
                    continue
                slot = categories.setdefault(
                    line.category_id,
                    {
                        "category_id": line.category_id,
                        "name": line.name,
                        "depth": line.depth,
                        "has_children": line.has_children,
                        "budget_cents": 0,
                        "actual_cents": 0,
                    },
                )
                slot["budget_cents"] += line.budget_cents
                slot["actual_cents"] += line.actual_cents
        cursor = _next_month(cursor)

    category_rows = list(categories.values())
    for row in category_rows:
        row["remaining_cents"] = row["budget_cents"] - row["actual_cents"]
    # Leaves only, so a parent's rolled-up budget is not counted alongside its children.
    underspend = sum(r["remaining_cents"] for r in category_rows if not r["has_children"])

    start_for_funding = plan.start_date or created
    funded = 0
    funding_block = None
    funding_category = config.get("category_id")
    funding_loan = config.get("loan_account_id")
    if funding_category or funding_loan:
        net, funding_block = _funding(db, plan, tree, funding_category, start_for_funding, funding_loan)
        funded += net
    funded += sum(e["amount_cents"] for e in manual_events(plan, tree) if e["item_kind"] == "contribution")

    remaining = max(target - funded, 0)
    n_months = _months_between(today, target_date) if target_date else None
    required_monthly = (remaining + n_months - 1) // n_months if n_months else None
    progress = round(funded / target * 100, 1) if target else 0.0

    return {
        "kind": "savings",
        "window": {"start": start_month.isoformat()[:7], "end": end_month.isoformat()[:7]},
        "months": months,
        "categories": category_rows,
        "underspend_cents": underspend,
        "net_cents": cumulative,
        "target_cents": target,
        "target_date": target_date.isoformat() if target_date else None,
        "funded_cents": funded,
        "remaining_cents": remaining,
        "progress_pct": progress,
        "months_remaining": n_months,
        "required_monthly_cents": required_monthly,
        "funding": funding_block,
        "headline_cents": cumulative,
        "headline_pct": progress,
    }


def derive_debt(db: Session, plan: Plan, tree) -> dict:
    """Simulate paying a fixed monthly amount across the plan's debt items, largest/smallest first."""
    config = _config(plan)
    payment = int(config.get("monthly_payment_cents") or 0)
    apr = int(config.get("apr_pct") or 0)
    strategy = config.get("strategy") or "avalanche"

    debts = [
        {
            "id": item.id,
            "name": item.description or (item.category.name if item.category else "Debt"),
            "initial_cents": abs(item.amount_cents),
            "balance_cents": abs(item.amount_cents),
            "interest_cents": 0,
            "payoff_month": None,
        }
        for item in plan.items
        if item.item_kind == "debt" and item.amount_cents != 0
    ]
    events = manual_events(plan, tree)
    if not debts:
        return {
            "kind": "debt",
            "note": "Add one item per debt (its outstanding balance) to project a payoff.",
            "monthly_payment_cents": payment,
            "apr_pct": apr,
            "strategy": strategy,
            "months_to_payoff": None,
            "total_interest_cents": 0,
            "debts": [],
            "schedule": [],
            "headline_cents": 0,
            "events": events,
        }

    order = sorted(debts, key=lambda d: d["initial_cents"], reverse=strategy == "avalanche")
    monthly_rate = apr / 100 / 12
    schedule: list[dict] = []
    months = 0
    total = sum(d["balance_cents"] for d in debts)
    while total > 0 and payment > 0 and months < MAX_PAYOFF_MONTHS:
        months += 1
        if monthly_rate:
            for debt in debts:
                if debt["balance_cents"] > 0:
                    interest = round(debt["balance_cents"] * monthly_rate)
                    debt["balance_cents"] += interest
                    debt["interest_cents"] += interest
        budget_cents = payment
        for debt in order:
            if budget_cents <= 0:
                break
            if debt["balance_cents"] <= 0:
                continue
            pay = min(budget_cents, debt["balance_cents"])
            debt["balance_cents"] -= pay
            budget_cents -= pay
            if debt["balance_cents"] == 0 and debt["payoff_month"] is None:
                debt["payoff_month"] = months
        total = sum(d["balance_cents"] for d in debts)
        schedule.append({"month": months, "remaining_cents": total})

    return {
        "kind": "debt",
        "monthly_payment_cents": payment,
        "apr_pct": apr,
        "strategy": strategy,
        "months_to_payoff": months if total == 0 and payment > 0 else None,
        "total_interest_cents": sum(d["interest_cents"] for d in debts),
        "debts": [
            {
                "id": d["id"],
                "name": d["name"],
                "initial_cents": d["initial_cents"],
                "interest_cents": d["interest_cents"],
                "payoff_month": d["payoff_month"],
            }
            for d in debts
        ],
        "schedule": schedule,
        "headline_cents": sum(d["initial_cents"] for d in debts),
        "events": events,
    }


def derive_event(db: Session, plan: Plan, tree) -> dict:
    config = _config(plan)
    budget_cents = int(config.get("budget_cents") or 0)
    events = manual_events(plan, tree)
    estimate = _outflow(events)
    income = _inflow(events)
    return {
        "kind": "event",
        "budget_cents": budget_cents,
        "estimate_cents": estimate,
        "income_cents": income,
        "remaining_cents": budget_cents - estimate,
        "headline_cents": estimate,
        "events": events,
    }


def derive_scenario(db: Session, plan: Plan, tree) -> dict:
    """Apply percentage adjustments to this month's actual income and spending."""
    config = _config(plan)
    inc_pct = int(config.get("income_adjust_pct") or 0)
    exp_pct = int(config.get("expense_adjust_pct") or 0)
    month = date.today().replace(day=1)
    data = budgets.build_month(db, month)
    events = manual_events(plan, tree)
    extra_in = _inflow(events)
    extra_out = _outflow(events)

    income = round(data.income_actual * (100 + inc_pct) / 100) + extra_in
    expense = round(data.expense_actual * (100 + exp_pct) / 100) + extra_out
    return {
        "kind": "scenario",
        "month": month.strftime("%Y-%m"),
        "income_adjust_pct": inc_pct,
        "expense_adjust_pct": exp_pct,
        "base_income_cents": data.income_actual,
        "base_expense_cents": data.expense_actual,
        "income_cents": income,
        "expense_cents": expense,
        "base_net_cents": data.income_actual - data.expense_actual,
        "net_cents": income - expense,
        "headline_cents": income - expense,
        "events": events,
    }


def derive_affordability(db: Session, plan: Plan, tree) -> dict:
    config = _config(plan)
    purchase = int(config.get("purchase_cents") or 0)
    when_raw = config.get("purchase_date")
    when = date.fromisoformat(when_raw) if when_raw else date.today()
    account = db.get(Account, plan.account_id) if plan.account_id else None

    balance = balance_at(db, account, when) if account else 0
    events = manual_events(plan, tree)
    item_delta = sum(e["amount_cents"] for e in events if (e["date"] or when) <= when)
    before = balance + item_delta
    after = before - purchase
    body = {
        "kind": "affordability",
        "purchase_cents": purchase,
        "purchase_date": when.isoformat(),
        "account_id": account.id if account else None,
        "account_name": account.name if account else None,
        "balance_before_cents": before,
        "balance_after_cents": after,
        "affordable": after >= 0,
        "shortfall_cents": max(0, -after),
        "headline_cents": after,
        "events": events,
    }
    if account is None:
        body["note"] = "Pick an account to project its balance; this is assuming a $0 starting balance."
    return body


def derive_generic(plan: Plan, tree) -> dict:
    events = manual_events(plan, tree)
    return {
        "kind": plan.type,
        "note": "This plan type is coming soon. Its manual items are listed below.",
        "inflow_cents": _inflow(events),
        "outflow_cents": _outflow(events),
        "headline_cents": sum(e["amount_cents"] for e in events),
    }


# ------------------------------------------------------------------- drift


def _drift(db: Session, events: list[dict]) -> list[dict]:
    """Attach the real transaction that fulfils each out-event, by category + amount + date window."""
    dated = [e for e in events if e["date"] and e["category_id"]]
    if not dated:
        return events
    lo = min(e["date"] for e in dated) - timedelta(days=MATCH_WINDOW_DAYS)
    hi = max(e["date"] for e in dated) + timedelta(days=MATCH_WINDOW_DAYS)
    candidates = list(
        db.scalars(
            select(Transaction)
            .where(
                Transaction.date >= lo,
                Transaction.date <= hi,
                Transaction.category_id.is_not(None),
                func.coalesce(Transaction.link_kind, "") != TRANSFER,  # not a transfer leg
            )
            .order_by(Transaction.date)
        ).unique()
    )
    by_id = {t.id: t for t in candidates}
    used: set[int] = set()

    # Honor explicit manual overrides first.
    for event in events:
        match_id = event.get("matched_transaction_id")
        if match_id and match_id in by_id:
            used.add(match_id)
            event["matched_date"] = by_id[match_id].date.isoformat()
            event["actual_cents"] = direction_effect(abs(by_id[match_id].amount_cents), event["direction"])

    for event in events:
        event.setdefault("matched_date", None)
        event.setdefault("actual_cents", None)
        if (
            event["matched_transaction_id"]
            or event["direction"] != "out"
            or not event["date"]
            or not event["category_id"]
        ):
            continue
        best = None
        best_gap = None
        for txn in candidates:
            if txn.id in used or txn.category_id != event["category_id"]:
                continue
            if event["account_id"] and txn.account_id and txn.account_id != event["account_id"]:
                continue
            if abs(txn.amount_cents) != abs(event["amount_cents"]):
                continue
            gap = abs((txn.date - event["date"]).days)
            if gap <= MATCH_WINDOW_DAYS and (best_gap is None or gap < best_gap):
                best, best_gap = txn, gap
        if best is not None:
            used.add(best.id)
            event["matched_transaction_id"] = best.id
            event["matched_date"] = best.date.isoformat()
            event["actual_cents"] = direction_effect(abs(best.amount_cents), event["direction"])

    for event in events:
        actual = event.get("actual_cents")
        if actual is None:
            event["variance_cents"] = None
        else:
            event["variance_cents"] = actual - event["amount_cents"]
    return events


# ----------------------------------------------------------------- payload


def derive(db: Session, plan: Plan) -> dict:
    tree = load_tree(db)
    if plan.type == "rolling":
        body = derive_rolling(db, plan, tree)
    elif plan.type == "goal":
        body = derive_goal(db, plan, tree)
    elif plan.type == "savings":
        body = derive_savings(db, plan, tree)
    elif plan.type == "debt":
        body = derive_debt(db, plan, tree)
    elif plan.type == "event":
        body = derive_event(db, plan, tree)
    elif plan.type == "scenario":
        body = derive_scenario(db, plan, tree)
    elif plan.type == "affordability":
        body = derive_affordability(db, plan, tree)
    else:
        body = derive_generic(plan, tree)

    if "events" not in body:
        body["events"] = manual_events(plan, tree)
    if plan.type != "rolling":
        body["events"] = _drift(db, body["events"])
    _sort_events(body["events"])
    if plan.type != "rolling":
        _attach_balances(db, plan, body["events"])
    # Everything above works in signed amounts; the wire keeps magnitude + direction.
    body["events"] = [to_public(e) for e in body["events"]]
    return body


def _item_out(item: PlanItem, tree) -> dict:
    return {
        "id": item.id,
        "date": item.date.isoformat() if item.date else None,
        "description": item.description,
        "category_id": item.category_id,
        "category_path": tree.path(item.category_id) if item.category_id else "",
        "account_id": item.account_id,
        "account_name": item.account.name if item.account else None,
        "amount_cents": abs(item.amount_cents),
        "direction": direction_of(item.amount_cents),
        "item_kind": item.item_kind,
        "source": item.source,
        "matched_transaction_id": item.matched_transaction_id,
        "matched_date": item.matched_transaction.date.isoformat() if item.matched_transaction else None,
    }


def plan_out(db: Session, plan: Plan, *, detail: bool = False) -> dict:
    tree = load_tree(db)
    body = derive(db, plan)
    payload = {
        "id": plan.id,
        "name": plan.name,
        "type": plan.type,
        "type_label": plan_types.PLAN_TYPES_BY_KEY[plan.type].label,
        "status": plan.status,
        "account_id": plan.account_id,
        "account_name": plan.account.name if plan.account else None,
        "start_date": plan.start_date.isoformat() if plan.start_date else None,
        "end_date": plan.end_date.isoformat() if plan.end_date else None,
        "notes": plan.notes,
        "config": _config(plan),
        "sort_order": plan.sort_order,
        "derived": body,
        "item_count": len(plan.items),
    }
    if detail:
        payload["items"] = [_item_out(item, tree) for item in plan.items]
        payload["events"] = body.get("events", [])
    return payload