# Testing

How to verify a change — the automated checks, then a manual UI pass in a throw-away database.

## Automated checks

```powershell
# repo root — backend
.\.venv\Scripts\python.exe -m pytest                                   # full suite
.\.venv\Scripts\python.exe -m pytest tests/test_plans.py -k rolling -v # one file / filtered
.\.venv\Scripts\python.exe -m ruff check .

# frontend/ — after any UI change
npm run lint:design
npm run typecheck
npm run build
```

The test suite runs the real Alembic migrations on a temp SQLite file, then loads
`samples/starter-config.json` — it never touches `data/budget.db`.

## Clean UI environment

`scripts/scratch_ui.py` builds a throw-away database (migrated + starter config, plus a demo
paycheck and a future-dated transaction), then serves the app against it:

```powershell
.\.venv\Scripts\python.exe scripts\scratch_ui.py   # backend on http://127.0.0.1:8000
cd frontend
npm run dev                                        # UI, open the vite URL (http://localhost:5173)
```

Flags: `--db` (default `data/scratch.db`), `--port`, `--no-seed`, `--reload`.

It refuses to delete the real `data/budget.db`, and the scratch file is gitignored. Re-running
resets the scratch file, so you always start clean.

## Manual UI pass — rolling plan

The rolling plan merges three sources (recurring, manual, ledger) through `app/services/events.py`.
To verify the merged stream:

1. Boot with the scratch environment above.
2. **Plans → Add plan → Rolling → account "Chequing"**.
3. On the plan detail:
   - **"Safe to spend"** = income minus commitments minus any future transaction.
   - The **Events** table shows the merged stream — recurring income + commitments, any manual
     items, and future-dated transactions (ledger) — each reducing the running balance.
   - A **"next"** chip marks the first dated event on/after today.
4. Add a manual item dated well beyond the plan's window (e.g. 6 months out) — it should **not**
   appear in the Events table (the stream drops manual items dated after `end`).

## Inspecting what changed

```powershell
git status          # modified files
git diff --stat     # summary
git diff            # full diff
```
