"""Plan type registry: the declarative list of plan behaviours the Plan section offers.

Mirrors ``app.services.category_config``: adding a plan type is a registry entry, not a schema
change. ``config_fields`` describes the parameters a type needs so the UI can render a create/edit
form generically; the engine in ``app.services.plans`` only special-cases the types it implements.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ConfigField:
    key: str
    label: str
    kind: str  # money | int | date | text | select | category | categories | paycheck
    placeholder: str = ""
    help: str = ""
    options: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class PlanType:
    key: str
    label: str
    description: str
    account_aware: bool
    implemented: bool
    config_fields: tuple[ConfigField, ...] = field(default_factory=tuple)
    item_kinds: tuple[str, ...] = ("custom",)

    @property
    def headline(self) -> str:
        return {
            "rolling": "safe to spend",
            "goal": "progress",
            "savings": "free to save",
            "debt": "months to payoff",
            "event": "estimate",
            "scenario": "net",
            "affordability": "after purchase",
        }.get(self.key, "")


PLAN_TYPES: tuple[PlanType, ...] = (
    PlanType(
        key="rolling",
        label="Rolling paycheck",
        description=(
            "Projects the days up to your next paychecks, allocating committed bills and "
            "discretionary spend and showing what is safe to spend."
        ),
        account_aware=True,
        implemented=True,
        item_kinds=("income", "commitment", "discretionary", "custom"),
        config_fields=(
            ConfigField(
                "paycheck_id",
                "Paycheck",
                "paycheck",
                "",
                "Choose a recurring income whose pay dates define the window, or create a new one.",
            ),
            ConfigField(
                "lookahead_paychecks",
                "Paychecks to look ahead",
                "int",
                "2",
                "The window runs from today through this many upcoming paychecks.",
            ),
            ConfigField("buffer_cents", "Keep a buffer of", "money", "0", "Reserved cushion before 'safe to spend'."),
            ConfigField(
                "variable_category_ids",
                "Variable monthly spending",
                "categories",
                "",
                "Categories spent every month but not on a fixed day (groceries, fuel, …).",
            ),
        ),
    ),
    PlanType(
        key="goal",
        label="Goal / sinking fund",
        description="Saves toward a target amount by a target date and tracks funding progress.",
        account_aware=False,
        implemented=True,
        item_kinds=("contribution", "custom"),
        config_fields=(
            ConfigField("target_cents", "Target amount", "money", "0", "How much you want to have saved."),
            ConfigField("target_date", "Target date", "date", "", "Optional. Used to size each period's contribution."),
            ConfigField(
                "category_id",
                "Funding category",
                "category",
                "",
                "Optional. Progress is measured from this category's transactions, net of spending. "
                "Set a target account to split funding from spending.",
            ),
        ),
    ),
    PlanType(
        key="savings",
        label="Savings plan",
        description=(
            "Projects a savings plan across every month from the start date to the target date — "
            "actual income and spending for months gone by, budgeted amounts for the months ahead — "
            "so you can see how much is free to set aside, and where to cut, to hit a savings target."
        ),
        account_aware=False,
        implemented=True,
        item_kinds=("contribution", "custom"),
        config_fields=(
            ConfigField("target_cents", "Savings target", "money", "0", "How much you want to have set aside."),
            ConfigField(
                "target_date",
                "Target date",
                "date",
                "",
                "Optional. The window ends here; used to size how much to set aside each month.",
            ),
            ConfigField(
                "category_id",
                "Funding category",
                "category",
                "",
                "Optional. Progress is measured from this category's transactions, net of spending. "
                "Set a target account to split funding from spending.",
            ),
        ),
    ),
    PlanType(
        key="debt",
        label="Debt payoff",
        description="Allocates a monthly payment across your debts to project a payoff order and date.",
        account_aware=False,
        implemented=True,
        item_kinds=("debt", "custom"),
        config_fields=(
            ConfigField(
                "monthly_payment_cents",
                "Monthly payment",
                "money",
                "0",
                "Total you pay toward these debts each month.",
            ),
            ConfigField(
                "apr_pct",
                "Annual interest (%)",
                "int",
                "0",
                "Optional. Applied to every debt balance each month.",
            ),
            ConfigField(
                "strategy",
                "Strategy",
                "select",
                options=(("avalanche", "Avalanche (largest balance first)"), ("snowball", "Snowball (smallest first)")),
            ),
        ),
    ),
    PlanType(
        key="event",
        label="Event / project",
        description="A freeform set of line items for a one-off project, with a budget versus estimate.",
        account_aware=False,
        implemented=True,
        item_kinds=("custom",),
        config_fields=(ConfigField("budget_cents", "Budget for the event", "money", "0"),),
    ),
    PlanType(
        key="scenario",
        label="What-if scenario",
        description="Adjusts income/expense assumptions to see the impact without changing real data.",
        account_aware=False,
        implemented=True,
        item_kinds=("custom",),
        config_fields=(
            ConfigField("income_adjust_pct", "Income change (%)", "int", "0"),
            ConfigField("expense_adjust_pct", "Expense change (%)", "int", "0"),
        ),
    ),
    PlanType(
        key="affordability",
        label="Affordability check",
        description="Checks whether a planned purchase fits against your projected cash flow.",
        account_aware=True,
        implemented=True,
        item_kinds=("custom",),
        config_fields=(
            ConfigField("purchase_cents", "Purchase amount", "money", "0"),
            ConfigField("purchase_date", "Purchase date", "date", ""),
        ),
    ),
)

PLAN_TYPES_BY_KEY: dict[str, PlanType] = {t.key: t for t in PLAN_TYPES}


class PlanTypeError(ValueError):
    """An unknown plan type was requested (shown to the user)."""


def get_type(key: str) -> PlanType:
    plan_type = PLAN_TYPES_BY_KEY.get(key)
    if plan_type is None:
        raise PlanTypeError(f"Unknown plan type: {key!r}")
    return plan_type


def type_payloads() -> list[dict]:
    return [
        {
            "key": t.key,
            "label": t.label,
            "description": t.description,
            "account_aware": t.account_aware,
            "implemented": t.implemented,
            "headline": t.headline,
            "item_kinds": list(t.item_kinds),
            "config_fields": [
                {
                    "key": f.key,
                    "label": f.label,
                    "kind": f.kind,
                    "placeholder": f.placeholder,
                    "help": f.help,
                    "options": [{"key": k, "label": v} for k, v in f.options],
                }
                for f in t.config_fields
            ],
        }
        for t in PLAN_TYPES
    ]