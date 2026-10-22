"""Core ledger tables: categories (a tree), accounts, transactions."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

EXPENSE = "expense"
INCOME = "income"
TRANSFER = "transfer"
REIMBURSEMENT = "reimbursement"


def direction_effect(amount_cents: int, direction: str) -> int:
    """A magnitude and a user-facing direction ("in"/"out") as a signed account effect.

    The one bridge between the two ways a direction is expressed: stored rows are *signed* and read
    through ``signed_delta``; magnitudes with an explicit ``direction`` (imports, plan items) read
    through this. Both meet at the same signed account effect, which is the invariant.
    """
    return amount_cents if direction == "in" else -amount_cents


def direction_of(effect_cents: int) -> str:
    """The direction a signed account effect moves money - the display twin of ``direction_effect``."""
    return "in" if effect_cents > 0 else "out"


def stored_amount(amount_cents: int, *, direction: str, kind: str, is_income: bool) -> int:
    """Stored ``Transaction.amount_cents`` for a magnitude + direction: the inverse of ``signed_delta``.

    A transfer leg is stored already signed (money out negative, money in positive); every other row
    is stored relative to its category, so the same rule that *reads* a row's effect (``signed_delta``)
    also *writes* it here, and the two cannot drift.
    """
    effect = direction_effect(amount_cents, direction)
    if kind == TRANSFER or is_income:
        return effect
    return -effect


def signed_delta(amount_cents: int, *, kind: str, is_income: bool) -> int:
    """The signed effect of a stored transaction on its account, given its category's direction.

    This is the one rule for what a row does to a balance; ``balances.delta_expression`` is its SQL
    twin and a test pins the two together, with ``stored_amount`` as the inverse for writers.

    Linking rows (a transfer or a reimbursement pair) only reclassifies them for budgets and
    reports; it never changes what the account balance does, which is why the category alone decides.
    """
    if kind == TRANSFER:
        return amount_cents
    return amount_cents if is_income else -amount_cents


class Category(Base):
    """A node in the category tree.

    Top-level nodes (``parent_id`` is NULL) are *sections* such as "Fixed Expenses"; they
    carry the ``kind`` (expense/income) that every descendant inherits. Budgets are only
    meaningful on leaves - a parent's budget is the sum of its children (see
    ``app.services.categories``).
    """

    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="RESTRICT"), index=True)
    kind: Mapped[str] = mapped_column(String(10), default=EXPENSE)  # expense | income
    monthly_budget_cents: Mapped[int] = mapped_column(Integer, default=0)
    description: Mapped[str] = mapped_column(Text, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(60), unique=True)
    kind: Mapped[str] = mapped_column(String(10), default="bank")  # bank | cash | savings | investment | debt
    opening_balance_cents: Mapped[int] = mapped_column(Integer, default=0)
    opening_date: Mapped[date | None] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Present only for loan accounts (kind == "debt"); doubles as the "is a loan" marker.
    loan = relationship("LoanDetails", back_populates="account", uselist=False, cascade="all, delete-orphan")


class Transaction(Base):
    """One ledger entry.

    ``amount_cents`` is signed relative to the category kind: a positive amount in an
    expense category is money out, in an income category money in; a negative amount
    is a refund / reversal of that.

    Rows that move money *between* your own hands are stored as two linked legs sharing a
    ``link_id``: a transfer (out of one account, into another) or a reimbursement (an outlay and
    its later repayment). ``link_kind`` says which; both kinds are excluded from budgets and
    reports. A transfer leg's amount is already the signed effect on its account.
    """

    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    description: Mapped[str] = mapped_column(String(200))
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="RESTRICT"))
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"))
    amount_cents: Mapped[int] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)
    # Set for imported rows so re-importing the same file is idempotent.
    import_hash: Mapped[str | None] = mapped_column(String(40), unique=True)
    # Optional link to a recurring template, so an imported charge can be traced to its recurring expense.
    recurring_template_id: Mapped[int | None] = mapped_column(ForeignKey("recurring_templates.id", ondelete="SET NULL"))
    # Shared by the two legs of one pairing; ``link_kind`` is the pairing's category kind
    # (``transfer`` or ``reimbursement``). Set means the row is paired and leaves budgets/reports.
    link_id: Mapped[str | None] = mapped_column(String(36), index=True)
    link_kind: Mapped[str | None] = mapped_column(String(20), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    category: Mapped[Category] = relationship(lazy="joined")
    account: Mapped[Account | None] = relationship(lazy="joined")
    recurring_template = relationship("RecurringTemplate")

    def cash_delta_cents(self, is_income: bool) -> int:
        """Effect on the owning account's balance; the caller resolves the category type's direction."""
        kind = self.category.kind if self.category is not None else EXPENSE
        return signed_delta(self.amount_cents, kind=kind, is_income=is_income)
