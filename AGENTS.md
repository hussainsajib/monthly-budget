# AGENTS.md

Project conventions. Follow these when building or editing the frontend UI.

## Stack

- Frontend: React 19 + Vite + TypeScript in `frontend/` (react-router, @tanstack/react-query).
- Backend: FastAPI + SQLAlchemy in `app/`; the React UI is served at `/`.
- No CSS framework — plain CSS with variables in `frontend/src/styles.css`.

## Frontend UI rules

- **Pickers:** category/account inputs MUST use the shared components in
  `frontend/src/components/selects.tsx` (`CategorySelect`, `CategoryFilter`,
  `AccountSelect`). They are searchable react-select controls with a cascading
  Category → Sub-category pair. Do **not** use native `<select>` for categories/accounts.
- **Tables:** use `@tanstack/react-table` **v8** (v9 renamed the API). Sorting is
  server-side — send `sort`/`dir` query params; see `TransactionsPage.tsx` and
  `app/services/transactions.py`.
- **Icons:** `lucide-react` named imports. **Tooltips:** `react-tooltip` (one
  `<Tooltip id=... />` per page, referenced via `data-tooltip-*`).
- **Icon buttons & static SVGs:** for icon-only ghost buttons (add/import/reset/save,
  right-aligned page-header action groups) and any pasted SVG used as a button icon,
  follow the recipe in `frontend/public/static/README.md`. Place SVGs under
  `frontend/public/static/`, reference with a `?v=N` cache-buster, use `icon-btn ghost`
  + `icon-img(-lg)`, and wrap header groups in `.row-actions`.
- **Pagination:** `react-paginate` (unwrap its `.default` — CJS interop). **Loading:**
  `react-content-loader` skeleton rows, not "Loading…" text.
- **Styling:** use the existing CSS variables (`--bg`, `--surface`, `--ink`, `--line`,
  `--accent`, …). Put new shared classes in `styles.css`. Support light and dark.
- **Design guardrails:** read `docs/design-guardrails.md` before any UI/styling
  change. Token-only colors/fonts (never hardcoded hex in components), one accent,
  no gradients, no shadows outside floating layers, no emoji, skeleton loaders not
  "Loading…", opinionated typography + tabular-nums for money. Run
  `npm run lint:design` after UI changes.
- **No code comments** unless the user asks.

## Backend touchpoints

- API handlers in `app/api/data.py` parse input and shape JSON; business rules live in
  `app/services/`. Money is integer cents. Migrations create schema only.

## UI checks (run after any frontend change)

```bash
# frontend/
npm run lint:design
npm run typecheck
npm run build
```

## Commands (backend checks)

```bash
# repo root
pytest
ruff check .
```

**Testing:** read `docs/testing.md` for the full workflow — automated checks, the scratch UI
environment (`python scripts/scratch_ui.py`), and how to verify a rolling plan on the UI.

## Run / boot (after checking out on a new machine)

Requires Python 3 + Node.js. Rebuild dirs (`.venv`, `frontend/node_modules`,
`frontend/dist`) are gitignored and regenerate on `pip install`/`npm install`.

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
alembic upgrade head            # create/migrate data\budget.db (schema only)
cd frontend && npm install && npm run build && cd ..
uvicorn app.main:app --reload   # http://127.0.0.1:8000 serves API + built UI
```

Bringing an existing `data/budget.db`? Just `alembic upgrade head` to migrate it and
skip `pip`/`npm` setup in the venv sense. UI dev with hot reload: `npm run dev` in
`frontend/` (proxies `/api` to uvicorn on 8000).

## Reusable skills

Global skills (react-select pickers, TanStack tables, UI feedback, design
guardrails, impeccable) are registered in `~/.config/opencode/opencode.jsonc`
under `skills.paths`, pointing at the `ai-skills` repo. They load automatically
when a task matches.

**Design precedence:** this project's own design system wins. `docs/design-guardrails.md`
plus the tokens in `frontend/src/styles.css` are the source of truth for colors, fonts,
spacing, and components. Use `impeccable` for design judgement and craft (hierarchy,
critique, polish, motion, copy) on top of that system — never to replace or override
this repo's tokens, components, or guardrails. When they conflict, follow the repo.
