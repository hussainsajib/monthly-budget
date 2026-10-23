# AGENTS.md — `frontend/src/components`

Shared UI used across pages. Read the root `AGENTS.md` and `docs/design-guardrails.md` first; this file only covers what is specific to this folder.

## What lives here

| File | Exports | Use for |
|------|---------|---------|
| `selects.tsx` | `CategorySelect`, `CategoryFilter`, `AccountSelect` | Every category/account input. Searchable react-select, cascading by configured level. Never use a native `<select>` for these. |
| `table.tsx` | `SortHeader`, `Bar` | Sortable `@tanstack/react-table` v8 headers and skeleton shimmer bars. |
| `ui.tsx` | `Loading`, `Modal`, `MonthField`, `ViewToggle`, `useViewMode` | Loading skeletons, dialogs, the shared month picker, list/card toggle. |
| `ColumnFilter.tsx` | `ColumnFilter` | Filter icon in a table header that opens a popover holding the column's control. |
| `TxnForm.tsx`, `TransferForm.tsx`, `LoanForm.tsx`, `PlanForm.tsx` | forms | Entry forms; each exports its own values type. |
| `ImportRuleDialog.tsx`, `AddCategoryModal.tsx` | dialogs | One-off flows built on `Modal`. |

## Rules

- **Reuse before adding.** Check this folder before writing a picker, month field, modal, or header control in a page. If two pages need the same thing, extract it here instead of copying.
- **Category pickers:** `CategoryFilter` takes `levelFrom` / `levelTo` to render a slice of the levels; several instances sharing one `value` stay in sync. Forms must use the non-system category list (`useCategories`); only filters and import use `useImportCategories`, which includes Transfers and Reimbursements.
- **Month picker:** use `MonthField`; pass `min`/`max` to restrict the range. It ignores empty values.
- **Table headers:** wrap sort and filter controls in `.th-inner`. Server-side sorting and filtering only; components here never sort or filter rows themselves.
- **Popovers:** `ColumnFilter` positions with `position: fixed` and closes on outside click, Escape, resize, and scroll. react-select menus portal to `document.body`, so outside-click handling must ignore `[class*="rs__menu"]`. Keep that exception in any new popover that hosts a picker.
- **Loading:** skeleton rows via `Loading` / `Bar`, never "Loading…" text.
- **Styling:** CSS variables from `styles.css` only, no hardcoded colors, no shadows outside floating layers. Add shared classes to `styles.css`, not inline.
- **Icons:** `lucide-react` named imports. Icon-only buttons need an `aria-label`.
- **Props:** keep components controlled (value + onChange from the page). Don't fetch data inside presentational components; pages own queries and pass data in.
- **No code comments** unless asked.

## After changes

Run from `frontend/`:

```bash
npm run lint:design
npm run typecheck
npm run build
```
