"""Loan metadata: what turns a ``kind='debt'`` account into a first-class loan.

An account stays the ledger container (opening balance + signed transaction deltas); this row
only carries the loan-facing facts that a plain account has nowhere to keep. It is 1:1 with an
account and is deleted with it, so no balance is ever duplicated here.

``rate_bps`` is the annual rate in basis points (6.49% -> 649) so it never rounds in a float
column and sorts exactly.
"""

from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class LoanDetails(Base):
    __tablename__ = "loan_details"

    account_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    loan_type: Mapped[str] = mapped_column(String(20), default="")
    lender: Mapped[str] = mapped_column(String(80), default="")
    original_principal_cents: Mapped[int] = mapped_column(Integer, default=0)
    rate_bps: Mapped[int] = mapped_column(Integer, default=0)
    is_interest_bearing: Mapped[bool] = mapped_column(Boolean, default=False)
    min_payment_cents: Mapped[int] = mapped_column(Integer, default=0)
    due_day: Mapped[int] = mapped_column(Integer, default=0)
    credit_limit_cents: Mapped[int] = mapped_column(Integer, default=0)
    reference: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")

    account = relationship("Account", back_populates="loan")
