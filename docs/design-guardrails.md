# Design guardrails

This project's frontend follows an anti-AI-slop design contract. The current
`frontend/src/styles.css` `:root` token block IS the contract — do not drift from
it. The full reasoning and a generic checklist live in the global
`design-guardrails` skill.

## The contract (this repo)

- **Backgrounds:** warm paper, not pure white/gray. `--bg: #f6f6f4`,
  `--surface: #ffffff` (dark: `#121211` / `#1a1a19`).
- **One accent:** `--accent: #2a78d6` (dark `#3987e5`). No gradient buttons, no
  violet/indigo, no purple.
- **Flat surfaces:** cards and rows are defined by `1px solid var(--line)`, not
  `box-shadow`. Shadows allowed only on `.modal` and `.flash-wrap` (floating
  layers).
- **Radius:** 0–12px. Pills (`border-radius: 99px`) only for chips/badges/wizard
  steps, never for buttons or cards.
- **Money:** `font-variant-numeric: tabular-nums` everywhere amounts appear
  (`td.num` / `.num`, `.stat`, `.money`, `.tile-value`, `.budget-input`).
- **Typography:** one font throughout — `system-ui` (`--font-body`), headings and the
  brand included. Numerals use `--font-money`, which aliases `--font-body`, so figures
  match the text around them; `tabular-nums` keeps columns aligned. Add fonts as
  `--font-*` tokens in `styles.css`, never inline in components.
- **Loading:** skeleton rows via `react-content-loader` (`Bar` in
  `components/table.tsx`), never "Loading…" text.
- **Icons:** `lucide-react` named imports. No emoji.

## Judgment calls (the 10 anti-slop moves)

Apply these to every UI change here. They are defaults to resist, not bans — but a
generic layer (everything carded, everything bordered, everything visible) is the tell.

1. **You might not need a card.** `.card` (`styles.css:33`) wraps tables, toolbars, the
   stat row, the month nav, and skeletons. Group with padding + typography first; keep
   `.card` for genuinely elevated/floating groups. Never stack a `.card` border with the
   table's own `td` rules (`styles.css:82`) around the same content — e.g. the budget
   stat row + table (`BudgetPage.tsx:144`, `:172`).
2. **It's okay to hide functionality.** Rare/secondary controls belong behind a trigger:
   advanced filters already live in a `Modal` (`TransactionsPage.tsx:419`), sort lives in
   headers. Don't spread every filter/action inline across the top level.
3. **You might not need a border.** Prefer spacing/layout separation before a `1px` line.
   Watch for doubled borders: `.tile` border (`styles.css:139`) + `.tile-foot` top border
   (`:144`); card border + row rules.
4. **Don't overload it.** One accent (`--accent`). State colors (`--good`/`--warn`/`--bad`)
   are for real exceptions only — not decoration. Keep full-row fills (`tr.low`/`tr.warn`,
   `styles.css:92`) and the multi-hue `.kind-dot` set (`:173`) restrained.
5. **Tabs aren't the only navigation.** `.tabs` (`styles.css:114`) is for in-context
   switching (Settings). Top-level destinations use `nav` links/routes — never tabs.
6. **You might not need a subheading.** Don't echo a heading in a subhead or restate the
   obvious; trust context. (The bold helper paragraph concept in `BudgetPage.tsx:246` is
   the kind of thing to replace with clearer hierarchy, not more text.)
7. **Design before you implement.** Mock the layout (even static markup) before wiring
   data/logic, so you don't lock into a weak pattern.
8. **Try different tools/models.** Iterate the same prompt across generators before
   committing to a direction.
9. **Don't just take what AI gives you.** Rewrite stock defaults (radius, spacing, type,
   color) into this repo's token system (`styles.css` `:root`). Never ship a library's
   out-of-the-box look.
10. **Learn the basics.** Fundamentals (hierarchy via scale/weight/spacing) — e.g.
    *Refactoring UI* — are the gap between AI output and professional work.

## Forbidden (check with `npm run lint:design`)

- Hardcoded hex / font-family / radius in `.tsx`/`.ts` files — colors and fonts
  must come from the CSS variables.
- `linear-gradient` / `radial-gradient` / `conic-gradient` anywhere.
- `box-shadow` outside `.modal`, `.flash-wrap`, and dropdown menus.
- The default AI palette: `#6366f1`, `#8b5cf6`, `#7c3aed`, `#6d28d9`,
  `#4f46e5`, `#a855f7`, and any purple.
- Emoji characters in components.
- Placeholder copy: `Loading…`, `Loading...`, `No data`, `Coming soon`, `Lorem`.
- Inline `style={{ color: '#...' }}` overrides.

Line-scoped escape hatch: append `/* design-ok */` to exempt a single line (data-viz
colors only).

## Check command

```bash
cd frontend && npm run lint:design
```