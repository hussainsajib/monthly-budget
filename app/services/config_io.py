"""Export / import the user-editable setup: categories, accounts, recurring items, monthly budgets, settings.

This keeps personal data out of migrations and git: the schema migrations stay generic, and a private JSON
file (see ``python -m app.cli export-config``) rebuilds your own setup on any database.

References are by name/path, never by database id, so a file can be loaded into a different database.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models import (
    REIMBURSEMENT,
    TRANSFER,
    Account,
    AppSetting,
    Category,
    ImportRule,
    LoanDetails,
    MonthlyBudget,
    RecurringTemplate,
    Transaction,
)
from app.services.account_config import ensure_account_config
from app.services.categories import MAX_DEPTH, Node, load_tree
from app.services.category_config import ensure_category_config, type_keys
from app.services.loan_config import ensure_loan_config
from app.services.recurring import list_templates, validate_schedule

FORMAT_VERSION = 1
Path = tuple[str, ...]


class ConfigError(ValueError):
    """The file is malformed or the import would break existing data (shown to the user)."""


def _names(node: Node) -> list[str]:
    parts: list[str] = []
    current: Node | None = node
    while current:
        parts.append(current.name)
        current = current.parent
    return parts[::-1]


def _loan_dict(details: LoanDetails | None) -> dict | None:
    if details is None:
        return None
    return {
        "loan_type": details.loan_type,
        "lender": details.lender,
        "original_principal_cents": details.original_principal_cents,
        "rate_bps": details.rate_bps,
        "is_interest_bearing": details.is_interest_bearing,
        "min_payment_cents": details.min_payment_cents,
        "due_day": details.due_day,
        "credit_limit_cents": details.credit_limit_cents,
        "reference": details.reference,
        "notes": details.notes,
    }


def _apply_loan(account: Account, entry: dict | None) -> None:
    """Attach/refresh a loan_details row from an exported account. ``None`` means 'not a loan'."""
    if not entry:
        if account.loan is not None:
            account.loan = None
        return
    details = account.loan or LoanDetails()
    details.loan_type = str(entry.get("loan_type", ""))[:20]
    details.lender = str(entry.get("lender", ""))[:80]
    details.original_principal_cents = int(entry.get("original_principal_cents", 0))
    details.rate_bps = int(entry.get("rate_bps", 0))
    details.is_interest_bearing = bool(entry.get("is_interest_bearing", False))
    details.min_payment_cents = int(entry.get("min_payment_cents", 0))
    details.due_day = int(entry.get("due_day", 0))
    details.credit_limit_cents = int(entry.get("credit_limit_cents", 0))
    details.reference = str(entry.get("reference", ""))
    details.notes = str(entry.get("notes", ""))
    account.loan = details


# ------------------------------------------------------------------ export


def export_config(db: Session) -> dict:
    ensure_category_config(db)
    ensure_account_config(db)
    ensure_loan_config(db)
    tree = load_tree(db)
    path_of = {node_id: _names(node) for node_id, node in tree.nodes.items()}

    categories = [
        {
            "path": path_of[n.id],
            "kind": n.category.kind,
            "monthly_budget_cents": n.category.monthly_budget_cents,
            "description": n.category.description,
            "sort_order": n.category.sort_order,
            "is_active": n.category.is_active,
        }
        for n in tree.walk()  # parents always precede their children
        if n.category.kind not in (TRANSFER, REIMBURSEMENT)  # system categories are not user config
    ]
    accounts = [
        {
            "name": a.name,
            "kind": a.kind,
            "opening_balance_cents": a.opening_balance_cents,
            "opening_date": a.opening_date.isoformat() if a.opening_date else None,
            "is_active": a.is_active,
            "loan": _loan_dict(a.loan),
        }
        for a in db.scalars(select(Account).order_by(Account.id))
    ]
    recurring = [
        {
            "description": t.description,
            "category": path_of[t.category_id],
            "account": t.account.name if t.account else None,
            "amount_cents": t.amount_cents,
            "day_of_month": t.day_of_month,
            "schedule": t.schedule,
            "is_active": t.is_active,
        }
        for t in list_templates(db)
    ]
    monthly_budgets = [
        {"month": b.month.strftime("%Y-%m"), "category": path_of[b.category_id], "amount_cents": b.amount_cents}
        for b in db.scalars(select(MonthlyBudget).order_by(MonthlyBudget.month, MonthlyBudget.category_id))
    ]
    import_rules = [
        {
            "match_text": r.match_text,
            "amount_cents": r.amount_cents,
            "account": r.account.name if r.account else None,
            "category": path_of.get(r.category_id, [r.category.name if r.category else str(r.category_id)]),
            "day_from": r.day_from,
            "day_to": r.day_to,
            "is_active": r.is_active,
        }
        for r in db.scalars(select(ImportRule).order_by(ImportRule.sort_order, ImportRule.id))
    ]
    settings = {s.key: s.value for s in db.scalars(select(AppSetting).order_by(AppSetting.key))}
    return {
        "version": FORMAT_VERSION,
        "categories": categories,
        "accounts": accounts,
        "recurring": recurring,
        "monthly_budgets": monthly_budgets,
        "import_rules": import_rules,
        "settings": settings,
    }


# ------------------------------------------------------------------ import


def _wipe_setup(db: Session) -> None:
    """Delete categories, accounts, recurring items and monthly budgets. Only legal when no transactions exist."""
    if db.scalar(select(func.count()).select_from(Transaction)):
        raise ConfigError(
            "This database already has transactions; replacing categories and accounts would orphan them. "
            "Import without --replace to merge instead."
        )
    db.execute(delete(MonthlyBudget))
    db.execute(delete(RecurringTemplate))
    db.execute(delete(ImportRule))
    db.execute(delete(LoanDetails))  # children before their accounts (FK cascade is not always enforced)
    # parent_id is ON DELETE RESTRICT: remove leaves first, repeatedly, until nothing is left
    while True:
        parents = select(Category.parent_id).where(Category.parent_id.is_not(None))
        result = db.execute(delete(Category).where(Category.id.not_in(parents)))
        if result.rowcount == 0:
            break
    db.execute(delete(Account))
    db.flush()


def _require(entry: dict, keys: tuple[str, ...], what: str) -> None:
    missing = [k for k in keys if k not in entry]
    if missing:
        raise ConfigError(f"{what}: missing {', '.join(missing)}")


def import_config(db: Session, data: dict, replace: bool = False) -> dict[str, int]:
    """Load a file produced by :func:`export_config`.

    Default is a merge: rows are matched by category path / account name and updated or created, nothing is
    deleted. ``replace=True`` first wipes the existing setup (refused if transactions exist).
    Everything happens in one transaction; any problem rolls it all back.
    """
    if data.get("version") != FORMAT_VERSION:
        raise ConfigError(f"Unsupported config version {data.get('version')!r} (expected {FORMAT_VERSION})")
    try:
        if replace:
            _wipe_setup(db)
        counts = _apply(db, data)
        db.commit()
        return counts
    except Exception:
        db.rollback()
        raise


def _apply(db: Session, data: dict) -> dict[str, int]:
    counts = {
        "categories": 0,
        "accounts": 0,
        "recurring": 0,
        "monthly_budgets": 0,
        "import_rules": 0,
        "settings": 0,
    }

    # categories, matched by path
    by_path: dict[Path, Category] = {tuple(_names(n)): n.category for n in load_tree(db).walk()}
    for entry in data.get("categories", []):
        _require(entry, ("path", "kind"), "category")
        path = tuple(entry["path"])
        if not path or not all(isinstance(p, str) and p.strip() for p in path):
            raise ConfigError(f"Bad category path: {entry['path']!r}")
        if len(path) > MAX_DEPTH:
            raise ConfigError(f"{' › '.join(path)}: nested more than {MAX_DEPTH} levels")
        if entry["kind"] not in type_keys(db):
            raise ConfigError(f"{' › '.join(path)}: unknown category kind {entry['kind']!r}")
        parent = by_path.get(path[:-1]) if len(path) > 1 else None
        if len(path) > 1 and parent is None:
            raise ConfigError(f"{' › '.join(path)}: its parent must appear earlier in the file")
        cat = by_path.get(path)
        if cat is None:
            cat = Category(name=path[-1], parent_id=parent.id if parent else None)
            db.add(cat)
            by_path[path] = cat
        cat.kind = parent.kind if parent else entry["kind"]
        cat.monthly_budget_cents = int(entry.get("monthly_budget_cents", 0))
        cat.description = entry.get("description", "")
        cat.sort_order = int(entry.get("sort_order", 0))
        cat.is_active = bool(entry.get("is_active", True))
        db.flush()  # children need this row's id
        counts["categories"] += 1

    # accounts, matched by name
    accounts = {a.name: a for a in db.scalars(select(Account))}
    for entry in data.get("accounts", []):
        _require(entry, ("name",), "account")
        acc = accounts.get(entry["name"])
        if acc is None:
            acc = Account(name=entry["name"])
            db.add(acc)
            accounts[acc.name] = acc
        acc.kind = entry.get("kind", "bank")
        acc.opening_balance_cents = int(entry.get("opening_balance_cents", 0))
        opening = entry.get("opening_date")
        acc.opening_date = date.fromisoformat(opening) if opening else None
        acc.is_active = bool(entry.get("is_active", True))
        _apply_loan(acc, entry.get("loan"))
        counts["accounts"] += 1
    db.flush()

    def category_for(path_list: list[str], what: str) -> Category:
        cat = by_path.get(tuple(path_list))
        if cat is None:
            raise ConfigError(f"{what}: unknown category {' › '.join(path_list)}")
        return cat

    # recurring items, matched by (description, category)
    existing = {(t.description.lower(), t.category_id): t for t in db.scalars(select(RecurringTemplate)).unique()}
    for entry in data.get("recurring", []):
        _require(entry, ("description", "category", "amount_cents", "day_of_month"), "recurring item")
        cat = category_for(entry["category"], f"recurring item {entry['description']!r}")
        account_name = entry.get("account")
        if account_name is not None and account_name not in accounts:
            raise ConfigError(f"recurring item {entry['description']!r}: unknown account {account_name!r}")
        tpl = existing.get((entry["description"].lower(), cat.id))
        if tpl is None:
            tpl = RecurringTemplate(description=entry["description"], category_id=cat.id)
            db.add(tpl)
        tpl.account_id = accounts[account_name].id if account_name else None
        tpl.amount_cents = int(entry["amount_cents"])
        tpl.day_of_month = int(entry.get("day_of_month", 1))
        tpl.schedule = validate_schedule(entry["schedule"]) if entry.get("schedule") is not None else None
        tpl.is_active = bool(entry.get("is_active", True))
        counts["recurring"] += 1

    # monthly budget overrides, matched by (month, category)
    for entry in data.get("monthly_budgets", []):
        _require(entry, ("month", "category", "amount_cents"), "monthly budget")
        cat = category_for(entry["category"], "monthly budget")
        year, month = (int(p) for p in entry["month"].split("-"))
        row = db.get(MonthlyBudget, (date(year, month, 1), cat.id))
        if row is None:
            row = MonthlyBudget(month=date(year, month, 1), category_id=cat.id, amount_cents=0)
            db.add(row)
        row.amount_cents = int(entry["amount_cents"])
        counts["monthly_budgets"] += 1

    # import rules, matched by (account, category, match_text)
    existing_rules = list(db.scalars(select(ImportRule)))
    for entry in data.get("import_rules", []):
        _require(entry, ("match_text", "account", "category"), "import rule")
        cat = category_for(entry["category"], f"import rule {entry['match_text']!r}")
        account_name = entry.get("account")
        if account_name not in accounts:
            raise ConfigError(f"import rule {entry['match_text']!r}: unknown account {account_name!r}")
        rule = next(
            (r for r in existing_rules if r.match_text == entry["match_text"] and r.category_id == cat.id), None
        )
        if rule is None:
            rule = ImportRule(match_text=entry["match_text"], category_id=cat.id)
            db.add(rule)
            existing_rules.append(rule)
        rule.account_id = accounts[account_name].id
        rule.category_id = cat.id
        rule.amount_cents = int(entry["amount_cents"]) if entry.get("amount_cents") is not None else None
        rule.day_from = int(entry["day_from"]) if entry.get("day_from") is not None else None
        rule.day_to = int(entry["day_to"]) if entry.get("day_to") is not None else None
        rule.is_active = bool(entry.get("is_active", True))
        counts["import_rules"] += 1

    for key, value in data.get("settings", {}).items():
        setting = db.get(AppSetting, key)
        if setting is None:
            db.add(AppSetting(key=key, value=str(value)))
        else:
            setting.value = str(value)
        counts["settings"] += 1
    return counts
