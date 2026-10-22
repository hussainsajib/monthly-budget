# Architecture: one ledger, many projections

This document describes how the domain concepts fit together and the direction the code is
heading. It is about *why* the pieces are shaped the way they are, not a file-by-file tour (the
README covers that).

## The one abstraction

Everything the app tracks reduces to a single primitive:

> **A signed, dated money movement attributed to an account (and optionally a category).**

An account's balance is never stored. It is:

```
balance(account) = opening_balance_cents + sum(signed delta of each movement)
```

The one sign rule lives in `app/models/ledger.py::signed_delta` (and its model mirror
`Transaction.cash_delta_cents`):

- a transfer leg is stored already signed (money out is negative, money in is positive);
- every other row is signed relative to its **category kind** — a positive amount is money out on
  an expense, money in on an income; a negative amount is a refund/reversal.

Linking a row (a transfer or a reimbursement) only reclassifies it for budgets and reports; it
never changes what the account balance does. The category alone decides the sign.

This is an event-sourced ledger: the movements are the source of truth, and every screen is a
projection over them.

## Everything is an event or a projection

| Concept | Is really | Where |
|---|---|---|
| `Transaction` | one **actual** event | `models/ledger.py` |
| Transfer (2 legs) | one event **paired** across two accounts | `services/transfers.py` |
| Reimbursement (2 legs) | one event **paired** to net to zero | `services/reimbursements.py` |
| Loan payment / disbursement | a transfer (events) | `services/loans.py` |
| Future-dated transaction | a **planned** event (in the ledger, `date > today`) | `services/cashflow.py` |
| `RecurringTemplate` | a **generator** of future events (schedule + template) | `services/recurring.py` |
| `PlanItem` | a **hypothetical** event | `models/planning.py` |
| Balance | the **integral** of the event stream | `services/cashflow.py` |
| Budget | a **constraint** on classified events | `services/budgets.py` |
| Report | a **rolling window** over classified events | `services/reports.py` |

So there are exactly two axes, and every concept is one of them:

1. **The cash axis** — dated signed movements. Drives balances, past and future.
2. **The classification axis** — a category `kind` (expense/income/transfer/reimbursement/...) that
   says what a movement *means*. Drives budgets and reports.

A loan is an account (`kind = "debt"`) with a 1:1 `LoanDetails` row for the loan-facing facts. The
balance still lives in the ledger, so a loan can never drift from its transactions. Internally the
balance is negative when you owe; every loan surface flips the sign to `owed_cents` (positive = you
owe).

## One sign rule, two faces

Amounts are integer cents. There are two ways a direction gets expressed, and they meet at one
invariant: **the signed effect on the account.**

- **stored rows** are signed relative to their category. `signed_delta(amount, kind, is_income)`
  reads that into an effect; `stored_amount(magnitude, direction, kind, is_income)` is its exact
  inverse, so writers and readers cannot disagree. Both live in `app/models/ledger.py`.
- **magnitude + direction** (imports, plan items, recurring templates) is the user-facing pair.
  `direction_effect(magnitude, direction)` is the one bridge to a signed effect, and `direction_of`
  is its display inverse.

So the whole codebase reduces to: turn every movement into a signed effect through
`app.models.ledger`, then add. `balances.delta_expression` is the SQL twin of `signed_delta` and
`tests/test_integrity.py` pins the pair (plus the inverse round-trip). Any new balance view must go
through one of those, never its own copy.

The internal **event stream works in signed amounts** (`amount_cents` = the effect); the API keeps
the magnitude+direction pair only because the UI still sends and shows it, converted at the single
boundary in `plans.derive` via `events.to_public`. `PlanItem` keeps its `direction` column as the
storage/API face until step 4 flips it; internally the effect comes from the one rule.

## One walk, stopped where you need it

`app/services/cashflow.py` is the single home for "what is this account's balance over time":

- `_walk` — one account's rows in date order, each with its signed delta and running balance;
- `build_ledger` — that walk, plus current/projected/lowest and alert levels (the Cash flow page);
- `balance_at(db, account, when)` — the walk stopped at a date (used by plan affordability);
- `running_deltas(db, accounts)` + `balance_on(timeline, when)` — the same walk for many accounts in
  one query, and a date lookup into it (used by the loan debt trend).

`app/services/balances.py::balance_deltas` is the SQL aggregate form of the same rule, used for the
accounts table and loan summaries. The sign math exists once (the model), in one SQL form and one
Python timeline form. Callers pick the output shape they need; they do not re-derive the rule.

### `opening_date` bounds every balance

`opening_balance_cents` is the balance **as of** `opening_date`; transactions dated before it are
excluded, because the opening balance already accounts for them. This is enforced in all three
balance forms:

- `cashflow._walk` / `balance_at` / `running_deltas` filter `date >= opening_date` (via the walk);
- `balances.balance_deltas` joins `Account` and applies the same condition in SQL;
- the accounts table (`data._account_stats`) reads its balance change from `balance_deltas`.

So the Accounts table, the Loans page and Cash flow agree, and each matches the model the Accounts
UI states: "Cash flow starts from the opening balance on the opening date." Imports never set an
opening date, so this only changes numbers for accounts that have one set alongside earlier
transactions.

## One event stream

`app/services/events.py` defines "a dated movement" once, as the `Event` shape, and produces it per
source:

- `recurring_events(db, start, end, income_only=...)` — active recurring templates expanded through
  `recurring.occurrences`;
- `manual_events(plan)` — a plan's hand-entered adjustments;
- `ledger_events(db, start, end, after=..., account_id=...)` — real transactions in a window;
- `event_stream(db, start=..., end=..., sources=...)` — merges the requested sources.

Plans build every projection from this stream instead of their own dict-building, so a future-dated
transaction, a recurring occurrence and a manual adjustment are interchangeable to the arithmetic.
In particular `derive_rolling` now adds future-dated transactions (source `ledger`) on top of its
starting balance. It passes `after=today` because rows through today are already inside that balance,
so nothing is counted twice — and now a known upcoming bill or deposit weighs on "safe to spend",
which was the point of the exercise.

An event's `amount_cents` is the signed effect on its account; `direction` is a display label kept
in step with the sign. The stream is the seam where a new source, or the sign rule, lands in one
place.

Where it is heading — one `events(...)` feeding every projection:

- **balances / cash flow** read actual + planned events (already one walk, see above);
- **plans** read recurring + manual + future ledger events;
- **budgets** read the classified subset (excluding transfers and paired reimbursements);
- **reports** roll the classified subset up the category tree.

The payoff is correctness by construction: an affordability check ("is all of this accounted for
before I set money aside?") consumes the *same* stream as cash flow and budgets, so nothing can be
missed, and each rule exists once.

### Roadmap

1. **Unify balance/timeline.** Done: one walk in `cashflow.py`, repointed `plans` and `loans`.
2. **Introduce the `Event` shape + event stream.** Done: `services/events.py`; `plans` builds from
   it and `derive_rolling` now folds in future-dated transactions.
3. **Unify sign.** Done: `signed_delta` / `stored_amount` / `direction_effect` / `direction_of` in
   the model are the one rule; `importing.signed_amount` is gone and the event stream is signed,
   converted to the wire's magnitude+direction only at `plans.derive`.
4. **Retire `PlanItem.direction` and generalize pairing.** Done: unified `transfer_id`/`reimbursement_id` into `link_id` + `link_kind`; renamed `RecurringTemplate.loan_account_id` to `to_account_id`; plan items store signed amounts and `direction` was dropped (API wire shape preserved).
5. **Forward budgets.** Expose `kind = actual | commitment | planned` on each budget line so
   rationing future expenses uses the same stream.

Steps 1-3 are service-layer refactors that keep the tables and API intact (done). Step 4 is the
only schema migration.

## Efficiency

Correctness and duplication are the first concern: one rule, one place. On runtime cost, balances
are computed per request — `build_ledger` walks an account's rows, and `balance_deltas` does an
indexed `SUM`. Both are fine at personal-ledger scale. If a large history ever shows up in
profiling, the next move is a materialized daily-balance summary table (one running-balance row per
account per day, updated transactionally on write) so "balance at any date" is an indexed range
lookup instead of a sum. Do not add that speculatively.
