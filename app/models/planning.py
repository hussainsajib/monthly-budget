"""Planning tables: recurring templates, per-month budgets and key/value app settings."""

from __future__ import annotations

from datetime import date

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.ledger import Account, Category


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


class MonthlyBudget(Base):
    """Budget for one leaf category in one month.

    ``Category.monthly_budget_cents`` is the default; a row here overrides it for ``month``
    (always the first day of that month).
    """

    __tablename__ = "monthly_budgets"

    month: Mapped[date] = mapped_column(Date, primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True)
    amount_cents: Mapped[int] = mapped_column(Integer)
