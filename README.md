# Monthly Budget

Small FastAPI + SQLite web app that replaces the "Transactions" and "Budget Tracker" sheets of
`Monthly Cost tracking.xlsx`: quick transaction entry, a category tree with budgets, bank CSV import,
a Budget Tracker report with charts, and a running-balance cash flow view.

## Run locally (Windows / PowerShell)

The backend lives in a virtual environment inside the project (`.venv`); the UI is a Vite + React +
TypeScript app in `frontend/`.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt

alembic upgrade head                 # create data\budget.db (tables only, no data)
python -m app.cli import-config samples/starter-config.json   # generic starter categories/accounts, or use your own file
python -m app.cli import-xlsx "Monthly Cost tracking (1).xlsx"   # one-off: load your old transactions

cd frontend
npm install
npm run build                        # writes frontend/dist
cd ..
uvicorn app.main:app --reload        # http://127.0.0.1:8000  (FastAPI serves the API and the built UI)
```

While working on the UI, run `npm run dev` in `frontend/` as well and open http://localhost:5173/ instead.
It hot-reloads and proxies `/api` to uvicorn on port 8000, so keep uvicorn running.

If you forget `npm run build`, the API still works but `/` answers 503 with a reminder. The Docker image builds
the UI for you.

Run the checks with `pytest` and `ruff check .` (and `npm run typecheck` in `frontend/`). Without activating the
venv, prefix commands with `.\.venv\Scripts\python -m` (e.g. `.\.venv\Scripts\python -m pytest`).

## Running on another machine

Copy the project folder to the new PC. You only need **Python 3** and **Node.js** installed there; SQLite is
built in. You can skip the rebuildable dirs to keep the copy light — they regenerate on the new machine:

- Skip: `.venv`, `frontend/node_modules`, `frontend/dist`, `.pytest_cache`, `.ruff_cache`.
- Keep if you want your existing data: `data/budget.db` (migrations create the schema, but the DB holds all your
  transactions and settings). Without it you start fresh.
- Keep if you want a settings fallback: `personal/` (your `config.json` backup).
- Keep `frontend/package-lock.json` so `npm install` reproduces the exact UI deps.

Then run the same steps as "Run locally" above:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt

alembic upgrade head                        # builds/migrates data\budget.db
python -m app.cli import-config samples\starter-config.json   # skip only if you brought budget.db

cd frontend
npm install
npm run build
cd ..

uvicorn app.main:app --reload                # http://127.0.0.1:8000
```

If you copied an existing `data/budget.db`, run `alembic upgrade head` to bring it up to the latest migration,
then skip `import-config` (it would only merge/starter data into your real one).

## Your own setup (kept out of git)

Migrations only create the schema: they contain no data. A new database starts empty, and you load a setup
into it from a JSON file. `samples/starter-config.json` is a generic starter (sample categories, budgets and
accounts); your real setup lives in your own private file, which can be saved and restored the same way, so it
never needs to go into a migration or the repository:

```powershell
python -m app.cli export-config personal\config.json     # save your setup (personal/ is gitignored)
python -m app.cli import-config personal\config.json     # merge it into this database
python -m app.cli import-config personal\config.json --replace   # fresh database: swap out the starter setup
python -m app.cli import-config samples/starter-config.json   # or start from the generic sample
```

Setting up a new machine: `alembic upgrade head`, then `import-config <your file>` (add `--replace` if you
already loaded the starter file), then
`import-xlsx` for transactions. `--replace` is refused once transactions exist, since it would orphan them;
use the default merge then. The file holds setup only (no transactions); back up `data/budget.db` for those.

## Using it

| Page | What it does |
|------|--------------|
| **Transactions** | Add a new entry at the top (typing a known description autofills category, account and amount; *Add this month's recurring items* creates rent, loan etc.; if `OLLAMA_URL` is set, a new description falls back to a local LLM for the category). Below: search/filter (a category filter includes its sub-categories), edit, delete, and **bulk move** selected rows to another category. The **Import** button opens the CSV importer. |
| **Import** | Upload a bank/card CSV, then review: filter rows (description, category incl. unassigned, date/month/year, amount), set a category for all shown rows, see possible duplicates, and import. Re-importing the same file is safe. |
| **Budget** | One month at a time: each lowest-level category's budget (editable for that month only), actual and remaining, totals for income and expenses, and a "left to assign" check. *Copy last month's budget* is one click. |
| **Report** | The rolling last 4 months: category × month table (parents roll up their sub-categories), vs-budget, net, and two charts. |
| **Cash flow** | Running balance per account including future-dated (planned) rows, with red/orange alert levels and the lowest point. Set an opening balance + date under **Settings → Accounts** first. |
| **Settings** | **Categories** (add, rename, re-parent, default budget, deactivate or delete to four levels; deleting one with transactions asks where to move them), **Accounts**, and **Recurring** items. |

Notes on behaviour:

* Amounts are stored as integer cents. In an expense category a positive amount is money out; in an income
  category it is money in. A negative amount is a refund/reversal.
* Budgets are set on the lowest level; a parent shows the sum of its children. A category's budget is its
  default; the Budget page can override it for a single month (table `monthly_budgets`). Nothing rolls over.
* Future-dated entries are "planned": shown on Cash flow, excluded from the Report.

## Project layout

```
app/
  main.py              app factory, router wiring
  core/                settings, money helpers, optional Basic auth
  db/                  SQLAlchemy base + session
  models/              ORM tables (categories tree, accounts, transactions, recurring, settings)
  schemas/             pydantic input/output models
  services/            all business logic (no HTTP): categories, reports, cashflow, importing, ...
  api/                 JSON endpoints: data.py (React UI), routes.py (autofill suggest, /healthz)
  spa.py               serves the built React app at / (catch-all, registered last)
frontend/              React UI (Vite + TypeScript); src/pages, src/components, src/api.ts
migrations/            Alembic revisions: schema only (0001 initial, 0003 monthly budgets); no data
samples/               starter-config.json: generic categories/accounts for new users and the tests
tests/                 pytest; runs the real migrations on a temp SQLite file, then loads the starter config
scripts/start.sh       container entrypoint: migrate, then serve
scripts/scratch_ui.py  throw-away UI test database (migrate + starter config + demo data, then serve)
```

Rule of thumb: API handlers parse input and shape JSON; services own the rules; models hold no logic beyond helpers.

### Changing the schema

```powershell
# edit app/models/*.py, then:
alembic revision --autogenerate -m "describe change"
alembic upgrade head
```

Review the generated file before applying; SQLite migrations run in batch mode.

## Deploying to Cloud Run

1. **Do not keep SQLite on Cloud Run** - the container disk is ephemeral and data would vanish on restart.
   Use Cloud SQL for PostgreSQL and set
   `DATABASE_URL=postgresql+psycopg2://USER:PASS@/DB?host=/cloudsql/PROJECT:REGION:INSTANCE`.
   The same migrations run on both databases.
2. Set `APP_PASSWORD` (and optionally `APP_USER`) - this enables HTTP Basic auth. Keep both in Secret Manager.
3. The `Dockerfile` runs `alembic upgrade head` on start, then `uvicorn` on `$PORT`.
   Migrations create empty tables, so a brand-new database needs its setup loaded once: run
   `python -m app.cli import-config <file>` against it (for example from your machine with `DATABASE_URL` pointed at
   Cloud SQL via the proxy), or just create categories in **Settings**.
4. `.gitlab-ci.yml` is a skeleton: lint + test on every push, build and deploy on the default branch.
   Fill in the CI variables listed at the top of the file. Use `--max-instances=1` while on a single DB.
5. Health check endpoint: `/healthz` (unauthenticated).

## Known limitations / next steps

* No CSRF protection (fine on localhost; add a token before exposing it, since Basic auth credentials are sent automatically by browsers).
* Credit-card balances are not modelled: card purchases are tracked as spending, and card payments are
  expenses paid from the chequing account.
* The report averages over the months in its 4-month window that have activity; the Excel sheet divided by a fixed 8.
