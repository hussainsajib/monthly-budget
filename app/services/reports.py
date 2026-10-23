"""Budget Tracker report: category tree x month actuals vs. monthly budget.

The window is the rolling last ``WINDOW_MONTHS`` calendar months (ending with the current
one) rather than a calendar year, so the report is always current without navigation.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from sqlalchemy import extract, func, select
from sqlalchemy.orm import Session

from app.models import TRANSFER, Category, Transaction
from app.services import budgets
from app.services.categories import Node, load_tree
from app.services.category_config import income_keys

WINDOW_MONTHS = 3


@dataclass
class ReportRow:
    category_id: int
    name: str
    depth: int
    kind: str
    is_income: bool
    has_children: bool
    months: list[int]  # rolled up actuals: own + all descendants
    budgets: list[int]  # rolled up per-month budgets: own + all descendants
    budget: int  # effective default monthly budget
    avg: int
    variance: int  # avg - budget (for expenses, positive = over budget)

    @property
    def total(self) -> int:
        return sum(self.months)

    @property
    def status(self) -> str:
        """CSS class: 'over' / 'under' relative to what is good for this kind."""
        if self.variance == 0:
            return ""
        good = self.variance > 0 if self.is_income else self.variance < 0
        return "under" if good else "over"


@dataclass
class BudgetReport:
    window: list[date]  # first-of-month dates, oldest -> newest
    active: list[int]  # indexes into the window that have any activity
    rows: list[ReportRow]
    expense_months: list[int]
    income_months: list[int]
    net_months: list[int]
    expense_budgets: list[int]
    income_budgets: list[int]
    expense_budget: int
    income_budget: int
    type_totals: dict[str, dict[str, int]]  # type key -> {"months": total, "budget": cents}

    @property
    def months(self) -> list[str]:
        """'YYYY-MM' labels for the window, oldest -> newest."""
        return [d.strftime("%Y-%m") for d in self.window]

    @property
    def n_active(self) -> int:
        return len(self.active)

    @property
    def avg_expense(self) -> int:
        return _average(sum(self.expense_months), self.n_active)

    @property
    def avg_income(self) -> int:
        return _average(sum(self.income_months), self.n_active)

    @property
    def last_active_index(self) -> int | None:
        return self.active[-1] if self.active else None


def _average(total: int, n: int) -> int:
    return round(total / n) if n else 0


def _add(a: list[int], b: list[int]) -> list[int]:
    return [x + y for x, y in zip(a, b, strict=True)]


def _display_depth(node: Node) -> int:
    """Depth ignoring the hidden "Transfer" system category, so its sub-categories read as top-level."""
    depth = 0
    parent = node.parent
    while parent is not None:
        if parent.category.kind != TRANSFER:
            depth += 1
        parent = parent.parent
    return depth


def _shift_month(month: date, delta: int) -> date:
    """First of the month ``delta`` months after (or before, if negative) ``month``."""
    index = month.year * 12 + (month.month - 1) + delta
    return date(index // 12, index % 12 + 1, 1)


def rolling_window(as_of: date, months: int = WINDOW_MONTHS) -> list[date]:
    """First-of-month dates for the ``months`` calendar months ending with ``as_of``'s month."""
    first = _shift_month(date(as_of.year, as_of.month, 1), -(months - 1))
    return [_shift_month(first, i) for i in range(months)]


def budget_report(db: Session, window_months: int = WINDOW_MONTHS, as_of: date | None = None) -> BudgetReport:
    """Aggregate actuals for the rolling window ending in ``as_of``'s month.

    Future-dated (planned) rows are excluded, and the current month is only counted up to ``as_of``.
    """
    as_of = as_of or date.today()
    window = rolling_window(as_of, window_months)
    n = len(window)
    position = {(d.year * 12 + d.month): i for i, d in enumerate(window)}
    per_month_budgets = [budgets.effective_budgets(db, d) for d in window]
    year, month = extract("year", Transaction.date), extract("month", Transaction.date)
    stmt = (
        select(Transaction.category_id, year.label("y"), month.label("m"), func.sum(Transaction.amount_cents))
        .where(
            Transaction.date >= window[0],
            Transaction.date <= as_of,
            Transaction.link_id.is_(None),  # paired transfers/reimbursements are not income or expense
            ~Transaction.category.has(Category.kind == TRANSFER),  # pending transfer legs neither
        )
        .group_by(Transaction.category_id, year, month)
    )
    own: dict[int, list[int]] = defaultdict(lambda: [0] * n)
    active: set[int] = set()
    for category_id, y, m, total in db.execute(stmt):
        i = position[int(y) * 12 + int(m)]
        own[category_id][i] = int(total)
        active.add(i)
    active_months = sorted(active)

    rows: list[ReportRow] = []
    income = income_keys(db)

    def build(node: Node) -> tuple[list[int], list[int]]:
        """Pre-order emit with post-order totals: reserve the slot, fill after children."""
        slot = len(rows)
        rows.append(None)  # type: ignore[arg-type]
        months = list(own.get(node.id, [0] * n))
        if node.children:
            node_budgets = [0] * n
        else:
            node_budgets = [per_month_budgets[i].get(node.id, 0) for i in range(n)]
        for child in node.children:
            child_months, child_budgets = build(child)
            months = _add(months, child_months)
            node_budgets = _add(node_budgets, child_budgets)
        cat = node.category
        if cat.kind != TRANSFER and (cat.is_active or any(months)):
            budget = node.effective_budget_cents
            avg = _average(sum(months), len(active_months))
            rows[slot] = ReportRow(
                node.id,
                node.name,
                _display_depth(node),
                cat.kind,
                cat.kind in income,
                bool(node.children),
                months,
                node_budgets,
                budget,
                avg,
                avg - budget,
            )
        else:
            rows[slot] = None  # type: ignore[assignment]
        return months, node_budgets

    tree = load_tree(db)
    for root in tree.roots:
        build(root)
    rows = [r for r in rows if r is not None]

    roots = [r for r in rows if r.depth == 0]

    def totals(flow_in: bool, attr: str) -> list[int]:
        out = [0] * n
        for r in roots:
            if r.is_income == flow_in:
                out = _add(out, getattr(r, attr))
        return out

    type_totals: dict[str, dict[str, int]] = {}
    for r in roots:
        slot = type_totals.setdefault(r.kind, {"months": 0, "budget": 0})
        slot["months"] += r.total
        slot["budget"] += r.budget

    expense_months, income_months = totals(False, "months"), totals(True, "months")
    return BudgetReport(
        window=window,
        active=active_months,
        rows=rows,
        expense_months=expense_months,
        income_months=income_months,
        net_months=[i - e for i, e in zip(income_months, expense_months, strict=True)],
        expense_budgets=totals(False, "budgets"),
        income_budgets=totals(True, "budgets"),
        expense_budget=sum(r.budget for r in roots if not r.is_income),
        income_budget=sum(r.budget for r in roots if r.is_income),
        type_totals=type_totals,
    )


def chart_payload(report: BudgetReport, month_index: int) -> dict:
    """Plain-dict data for the two charts (dollars, not cents)."""

    def dollars(cents: int) -> float:
        return round(cents / 100, 2)

    top = sorted(
        (
            (r.name, r.months[month_index], r.budgets[month_index])
            for r in report.rows
            if r.depth == 1 and not r.is_income and r.months[month_index] > 0
        ),
        key=lambda t: t[1],
        reverse=True,
    )[:12]
    return {
        "spending": [dollars(c) for c in report.expense_months],
        "income": [dollars(c) for c in report.income_months],
        "categories": [t[0] for t in top],
        "category_actual": [dollars(t[1]) for t in top],
        "category_budget": [dollars(t[2]) for t in top],
    }
