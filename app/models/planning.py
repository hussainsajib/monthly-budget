"""Planning tables: recurring templates, per-month budgets and key/value app settings."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.ledger import Account, Category, Transaction


class RecurringTemplate(Base):
    __tablename__ = "recurring_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    description: Mapped[str] = mapped_column(String(200))
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"))
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"))
    amount_cents: Mapped[int] = mapped_column(Integer)
    day_of_month: Mapped[int] = mapped_column(Integer)  # legacy monthly day; clamped to month length on use
    # Flexible recurrence. None = monthly on day_of_month. See app.services.recurring for the format.
    schedule: Mapped[dict | None] = mapped_column(JSON)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    category: Mapped[Category] = relationship(lazy="joined")
    account: Mapped[Account | None] = relationship(lazy="joined")


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(String(200))


class ImportRule(Base):
    """Custom import rule: a match condition that auto-assigns a category.

    A rule fires when a transaction's description contains ``match_text`` (empty = any; split on
    ``|`` so any one of several phrases matches), its account equals ``account_id``, its amount
    equals ``amount_cents`` (None = any) and its day of the month falls inside the optional
    [day_from, day_to] window (1..31). A rule must carry at least one of description/amount/day so
    it actually identifies something. Rules are consulted only when learned history has no
    suggestion, in ``sort_order`` then id order; the first active rule that matches wins.
    ``sort_order`` also drives the Settings UI ordering.
    """

    __tablename__ = "import_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    match_text: Mapped[str] = mapped_column(String(256))
    amount_cents: Mapped[int | None] = mapped_column(Integer)  # exact (absolute) amount match when set
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    day_from: Mapped[int | None] = mapped_column(Integer)  # day of month window (1..31), inclusive
    day_to: Mapped[int | None] = mapped_column(Integer)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    account: Mapped[Account] = relationship(lazy="joined")
    category: Mapped[Category] = relationship(lazy="joined")


class Plan(Base):
    """A hypothetical future projection derived from real data.

    Plans never write to the ledger. ``type`` selects a behaviour (see ``app.services.plan_types``)
    and ``config`` carries that type's parameters. Account-aware types point at an ``account_id``
    whose projected balance they track.
    """

    __tablename__ = "plans"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    type: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(10), default="active")  # active | archived | done
    config: Mapped[dict | None] = mapped_column(JSON)
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"))
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str] = mapped_column(Text, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    account: Mapped[Account | None] = relationship(lazy="joined")
    items: Mapped[list[PlanItem]] = relationship(
        back_populates="plan", cascade="all, delete-orphan", order_by="PlanItem.sort_order, PlanItem.id"
    )


class PlanItem(Base):
    """A user's manual adjustment layered on top of a plan's derived projection.

    ``amount_cents`` is a positive magnitude; ``direction`` says which way it moves. An item may
    link a ``category_id`` (so it can be matched to a real transaction for drift) or be freeform.
    """

    __tablename__ = "plan_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    date: Mapped[date | None] = mapped_column(Date, index=True)
    description: Mapped[str] = mapped_column(String(200), default="")
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"))
    amount_cents: Mapped[int] = mapped_column(Integer, default=0)
    direction: Mapped[str] = mapped_column(String(3), default="out")  # in | out
    item_kind: Mapped[str] = mapped_column(String(20), default="custom")
    source: Mapped[str] = mapped_column(String(10), default="manual")  # manual | recurring | future_txn
    ref_id: Mapped[int | None] = mapped_column(Integer)
    matched_transaction_id: Mapped[int | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="SET NULL")
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    plan: Mapped[Plan] = relationship(back_populates="items")
    category: Mapped[Category | None] = relationship(lazy="joined")
    account: Mapped[Account | None] = relationship(lazy="joined")
    matched_transaction: Mapped[Transaction | None] = relationship(lazy="joined")


class MonthlyBudget(Base):
    """Budget for one leaf category in one month.

    ``Category.monthly_budget_cents`` is the default; a row here overrides it for ``month``
    (always the first day of that month).
    """

    __tablename__ = "monthly_budgets"

    month: Mapped[date] = mapped_column(Date, primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True)
    amount_cents: Mapped[int] = mapped_column(Integer)
