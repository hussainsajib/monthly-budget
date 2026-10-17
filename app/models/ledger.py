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


def signed_delta(amount_cents: int, *, kind: str, is_income: bool) -> int:
    """The signed effect of a transaction on its account, given its category's direction.

    This is the one rule for what a row does to a balance; ``balances.delta_expression`` is its SQL
    twin and a test pins the two together. A transfer leg is stored already signed (money out
    negative, money in positive); every other row is signed relative to its category, so a positive
    amount is money out on an expense and money in on an income.

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

    A transfer between two accounts is stored as two rows sharing a ``transfer_id``: an
    outgoing leg (negative ``amount_cents``, the source account) and an incoming leg
    (positive, the destination). Transfer rows are neither income nor expense, so they are
    excluded from budgets and reports; their amount is already the signed effect on the account.
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
    # Shared by the two legs of an account-to-account transfer (out of one account, into another).
    transfer_id: Mapped[str | None] = mapped_column(String(36), index=True)
    # Shared by a reimbursable expense and its later repayment; both are excluded from budget/reports.
    reimbursement_id: Mapped[str | None] = mapped_column(String(36), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    category: Mapped[Category] = relationship(lazy="joined")
    account: Mapped[Account | None] = relationship(lazy="joined")
    recurring_template = relationship("RecurringTemplate")

    def cash_delta_cents(self, is_income: bool) -> int:
        """Effect on the owning account's balance; the caller resolves the category type's direction."""
        kind = self.category.kind if self.category is not None else EXPENSE
        return signed_delta(self.amount_cents, kind=kind, is_income=is_income)
