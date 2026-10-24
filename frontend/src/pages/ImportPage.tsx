import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Filter } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Tooltip } from 'react-tooltip'
import { api } from '../api'
import { AccountSelect, CategoryFilter, CategorySelect } from '../components/selects'
import { ActionMenu } from '../components/ActionMenu'
import { AddImportRuleModal, UpdateImportRuleModal, type RuleDraft } from '../components/ImportRuleDialog'
import { NO_FILTERS, isFiltered, makeRowMatcher, type ImportFilters } from '../importFilter'
import { centsToInput, formatMoney } from '../money'
import { useAccounts, useImportCategories } from '../queries'
import type { ImportPreviewRow } from '../types'
import { useRun, useToast } from '../toast'

interface Row extends ImportPreviewRow {
  include: boolean
}

const SESSION_KEY = 'import-session'

interface SavedSession {
  account_id: number | null
  amount_sign: string
  rows: Row[]
}

export default function ImportPage() {
  const run = useRun()
  const { fail } = useToast()
  const navigate = useNavigate()
  const categories = useImportCategories()
  const accounts = useAccounts()
  const recurring = useQuery({ queryKey: ['recurring-all'], queryFn: () => api.recurring() })
  const fileRef = useRef<HTMLInputElement>(null)
  const [accountId, setAccountId] = useState<number | null>(null)
  const [amountSign, setAmountSign] = useState('positive_is_expense')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [filters, setFilters] = useState<ImportFilters>(NO_FILTERS)
  const [bulkCategory, setBulkCategory] = useState<number | null>(null)
  const [onlyUnassigned, setOnlyUnassigned] = useState(true)
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null)
  const [updateDraft, setUpdateDraft] = useState<RuleDraft | null>(null)
  const restoredRef = useRef(false)

  /** Fill blank categories from the current rules/history; manual picks are left untouched. */
  async function reapplyRules(acc: number | null, currentRows: Row[]): Promise<Row[] | null> {
    const payload = currentRows.map((r) => ({
      date: r.date,
      description: r.description,
      amount_cents: r.amount_cents,
      direction: r.direction,
      category_id: r.category_id,
    }))
    const res = await run(() => api.applyImportRules(acc, payload))
    if (!res) return null
    return currentRows.map((r, i) => ({ ...r, category_id: res.category_ids[i] ?? r.category_id }))
  }

  // Restore a saved import after a refresh, then re-run rules so newly created rules fill in blanks.
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return
    let session: SavedSession
    try {
      session = JSON.parse(raw)
    } catch {
      localStorage.removeItem(SESSION_KEY)
      return
    }
    if (!session || !Array.isArray(session.rows) || session.rows.length === 0) {
      localStorage.removeItem(SESSION_KEY)
      return
    }
    setAccountId(session.account_id)
    setAmountSign(session.amount_sign)
    setRows(session.rows)
    void reapplyRules(session.account_id, session.rows).then((updated) => updated && setRows(updated))
  }, [])

  // Persist the in-progress import so a refresh never loses the user's ticks and category picks.
  useEffect(() => {
    if (!rows) return
    const session: SavedSession = { account_id: accountId, amount_sign: amountSign, rows }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  }, [rows, accountId, amountSign])

  function cancelImport() {
    localStorage.removeItem(SESSION_KEY)
    setRows(null)
    setAccountId(null)
    setAmountSign('positive_is_expense')
    setFilters(NO_FILTERS)
    setBulkCategory(null)
  }

  const draftFromRow = (r: Row): RuleDraft => ({
    match_text: r.description.slice(0, 256),
    amount: centsToInput(r.amount_cents),
    account_id: accountId,
    day_from: Number(r.date.slice(8, 10)),
    day_to: null,
    category_id: r.category_id,
    is_active: true,
  })

  async function preview(e: FormEvent) {
    e.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!file || busy) return
    const form = new FormData()
    form.append('file', file)
    if (accountId !== null) form.append('account_id', String(accountId))
    form.append('amount_sign', amountSign)
    setBusy(true)
    const result = await run(() => api.importPreview(form))
    setBusy(false)
    if (result) {
      setFilters(NO_FILTERS)
      setRows(result.map((r) => ({ ...r, include: !r.duplicate })))
    }
  }

  const patch = (index: number, change: Partial<Row>) =>
    setRows((rs) => rs && rs.map((r, i) => (i === index ? { ...r, ...change } : r)))

  useEffect(() => {
    if (!isFiltered(filters)) return
    const matches = makeRowMatcher(filters, categories.data ?? [])
    setRows((rs) => {
      if (!rs || rs.every((r) => !r.include || matches(r))) return rs
      return rs.map((r) => (r.include && !matches(r) ? { ...r, include: false } : r))
    })
  }, [filters, categories.data])

  const needsFix = (r: Row) => r.include && r.category_id === null

  function jumpToFirstFix() {
    const first = rows?.findIndex(needsFix) ?? -1
    if (first < 0 || !rows) return
    const hidden = !makeRowMatcher(filters, categories.data ?? [])(rows[first])
    if (hidden) setFilters(NO_FILTERS) // the row is filtered out: show everything so it can be seen
    // wait a moment so a cleared filter has rendered the row
    setTimeout(
      () => document.getElementById(`imp-row-${first}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      hidden ? 50 : 0,
    )
  }

  async function doImport(rowsToImport: Row[]) {
    setBusy(true)
    const done = await run(
      () =>
        api.importCommit(
          accountId,
          rowsToImport.map((r) => ({
            date: r.date,
            description: r.description,
            amount_cents: r.amount_cents,
            direction: r.direction,
            category_id: r.category_id,
            key: r.key,
            recurring_template_id: r.recurring_template_id,
            balance_cents: r.balance_cents,
          })),
        ),
      (r) => `Imported ${r.imported} transaction(s)`,
    )
    if (done) {
      const items = (rows ?? []).filter((r) => r.balance_cents != null).map((r) => ({ key: r.key, balance_cents: r.balance_cents as number }))
      if (items.length) await run(() => api.importBalances(items))
    }
    setBusy(false)
    if (done) {
      localStorage.removeItem(SESSION_KEY)
      navigate('/transactions')
    }
  }

  async function commit() {
    if (!rows || busy) return
    const chosen = rows.filter((r) => r.include)
    const missing = chosen.filter((r) => r.category_id === null)
    if (missing.length > 0) {
      jumpToFirstFix()
      return fail(`${missing.length} ticked row(s) still need a category. They are highlighted; nothing was imported.`)
    }
    if (chosen.length === 0) {
      const items = rows.filter((r) => r.balance_cents != null).map((r) => ({ key: r.key, balance_cents: r.balance_cents as number }))
      if (items.length === 0) return fail('Tick at least one row to import')
      setBusy(true)
      const res = await run(() => api.importBalances(items), (r) => `No new rows; saved bank balances on ${r.updated} existing transaction(s)`)
      setBusy(false)
      if (res) {
        localStorage.removeItem(SESSION_KEY)
        navigate('/transactions')
      }
      return
    }
    await doImport(chosen)
  }

  /** Import exactly what the current filters are showing, ignoring the per-row include ticks. */
  async function commitFiltered() {
    if (!rows || busy) return
    const shown = rows.filter(makeRowMatcher(filters, categories.data ?? []))
    if (shown.length === 0) return fail('No rows match these filters')
    const missing = shown.filter((r) => r.category_id === null)
    if (missing.length > 0) {
      jumpToFirstFix()
      return fail(`${missing.length} of the shown row(s) still need a category; nothing was imported.`)
    }
    await doImport(shown)
  }

  async function applyRulesToPreview() {
    if (!rows) return
    const updated = await reapplyRules(accountId, rows)
    if (updated) setRows(updated)
  }

  if (rows) {
    const matches = makeRowMatcher(filters, categories.data ?? [])
    const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => matches(r))
    const visibleIndexes = new Set(visible.map(({ i }) => i))
    const allVisibleIncluded = visible.length > 0 && visible.every(({ r }) => r.include)
    const toFix = rows.filter(needsFix).length
    const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort()
    const years = [...new Set(rows.map((r) => r.date.slice(0, 4)))].sort()
    const setFilter = <K extends keyof ImportFilters>(key: K, value: ImportFilters[K]) =>
      setFilters((f) => ({ ...f, [key]: value }))

    const bulkTargets = visible.filter(({ r }) => !onlyUnassigned || r.category_id === null)
    const applyBulkCategory = () => {
      if (bulkCategory === null) return fail('Pick a category to apply')
      if (bulkTargets.length === 0) return fail('No shown rows to update')
      const targets = new Set(bulkTargets.map(({ i }) => i))
      setRows(rows.map((r, i) => (targets.has(i) ? { ...r, category_id: bulkCategory, include: true } : r)))
    }

    return (
      <>
        <div className="row" style={{ alignItems: 'center' }}>
          <h1 style={{ margin: 0 }}>
            Review import <span className="chip">{rows.length} rows</span>
          </h1>
          <span className="row-actions">
            <button className="secondary" type="button" onClick={cancelImport}>
              Cancel
            </button>
          </span>
        </div>
        {toFix > 0 && (
          <div className="flash err row" style={{ alignItems: 'center' }}>
            <span>
              <b>{toFix}</b> ticked row(s) need a category before you can import.
            </span>
            <button type="button" className="secondary small shrink" onClick={jumpToFirstFix}>
              Jump to first
            </button>
            <button
              type="button"
              className="secondary small shrink"
              onClick={() => setFilters({ ...NO_FILTERS, category: 'none' })}
            >
              Show only unassigned
            </button>
            <button
              type="button"
              className="secondary small shrink"
              onClick={() => setRows(rows.map((r) => (needsFix(r) ? { ...r, include: false } : r)))}
            >
              Untick them and import the rest
            </button>
          </div>
        )}

        <div className="card">
          <div className="grid">
            <div>
              <label htmlFor="if-text">Description contains</label>
              <input
                id="if-text"
                type="search"
                placeholder="e.g. SEND E-TFR"
                value={filters.text}
                onChange={(e) => setFilter('text', e.target.value)}
              />
            </div>
            <div className="field-cat">
              <CategoryFilter
                id="if-category"
                categories={categories.data ?? []}
                value={filters.category}
                onChange={(v) => setFilter('category', v)}
                unassigned
              />
            </div>
            <div>
              <label htmlFor="if-year">Year</label>
              <select id="if-year" value={filters.year} onChange={(e) => setFilter('year', e.target.value)}>
                <option value="">All years</option>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="if-month">Month</label>
              <select id="if-month" value={filters.month} onChange={(e) => setFilter('month', e.target.value)}>
                <option value="">All months</option>
                {months.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="if-from">From</label>
              <input id="if-from" type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
            </div>
            <div>
              <label htmlFor="if-to">To</label>
              <input id="if-to" type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
            </div>
            <div>
              <label htmlFor="if-min">Amount from ($)</label>
              <input
                id="if-min"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={filters.min}
                onChange={(e) => setFilter('min', e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="if-max">Amount to ($)</label>
              <input
                id="if-max"
                type="text"
                inputMode="decimal"
                placeholder="no limit"
                value={filters.max}
                onChange={(e) => setFilter('max', e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="if-dir">Money</label>
              <select
                id="if-dir"
                value={filters.direction}
                onChange={(e) => setFilter('direction', e.target.value as ImportFilters['direction'])}
              >
                <option value="">In and out</option>
                <option value="out">Out (expenses)</option>
                <option value="in">In (income)</option>
              </select>
            </div>
          </div>
          <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
            <span className="small muted">
              Showing <b>{visible.length}</b> of {rows.length} rows
            </span>
            {isFiltered(filters) && (
              <button type="button" className="secondary small shrink" onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </button>
            )}
          </div>
        </div>

        <div className="card row" style={{ alignItems: 'end' }}>
          <div>
            <label htmlFor="if-bulk">Set category for the {visible.length} shown row(s)</label>
            <CategorySelect
              id="if-bulk"
              categories={categories.data ?? []}
              value={bulkCategory}
              onChange={setBulkCategory}
              blank="Choose category…"
            />
          </div>
          <label className="check shrink">
            <input type="checkbox" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} />{' '}
            Only rows without a category
          </label>
          <button
            type="button"
            className="shrink"
            onClick={applyBulkCategory}
            disabled={bulkCategory === null || bulkTargets.length === 0}
          >
            Apply to {bulkTargets.length} row(s)
          </button>
        </div>

        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Tick all shown rows"
                    checked={allVisibleIncluded}
                    onChange={() =>
                      setRows(rows.map((r, i) => (visibleIndexes.has(i) ? { ...r, include: !allVisibleIncluded } : r)))
                    }
                  />
                </th>
                <th>Date</th>
                <th>Description</th>
                <th>Recurring</th>
                <th>Category</th>
                <th className="num">Amount</th>
                <th></th>
                <th>
                  <span className="sr-only">Create rule</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ r, i }) => (
                <tr key={r.key} id={`imp-row-${i}`} className={needsFix(r) ? 'needs-fix' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Import ${r.description}`}
                      checked={r.include}
                      onChange={(e) => patch(i, { include: e.target.checked })}
                    />
                  </td>
                  <td>{r.date}</td>
                  <td>{r.description}</td>
                  <td>
                    <select
                      aria-label={`Recurring expense for ${r.description}`}
                      value={r.recurring_template_id ?? ''}
                      onChange={(e) => patch(i, { recurring_template_id: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">—</option>
                      {recurring.data?.map((rc) => (
                        <option key={rc.id} value={rc.id}>
                          {rc.description}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <CategorySelect
                      categories={categories.data ?? []}
                      value={r.category_id}
                      onChange={(id) => patch(i, { category_id: id })}
                      showLabels={false}
                    />
                  </td>
                  <td className={`num${r.direction === 'in' ? ' under' : ''}`}>
                    {r.direction === 'in' && '+'}
                    {formatMoney(r.amount_cents)}
                  </td>
                  <td>{r.duplicate && <span className="chip">possible duplicate</span>}</td>
                  <td className="num">
                    <ActionMenu
                      label={`Import rule from ${r.description}`}
                      tooltipId="import-tip"
                      tooltip="Create or update an import rule"
                      items={[
                        { key: 'new', label: 'Create new rule', onSelect: () => setRuleDraft(draftFromRow(r)) },
                        { key: 'update', label: 'Update existing rule', onSelect: () => setUpdateDraft(draftFromRow(r)) },
                      ]}
                    >
                      <Filter size={16} />
                    </ActionMenu>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No rows match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="row">
          <button className="shrink" type="button" onClick={commitFiltered} disabled={busy}>
            Import the {visible.length} shown row(s)
          </button>
          <button className="secondary shrink" type="button" onClick={commit} disabled={busy}>
            Import {rows.filter((r) => r.include).length} ticked row(s)
          </button>
          <button className="secondary shrink" type="button" onClick={cancelImport}>
            Cancel
          </button>
        </div>

        {ruleDraft && (
          <AddImportRuleModal initial={ruleDraft} onClose={() => setRuleDraft(null)} onAdded={applyRulesToPreview} />
        )}
        {updateDraft && (
          <UpdateImportRuleModal row={updateDraft} onClose={() => setUpdateDraft(null)} onUpdated={applyRulesToPreview} />
        )}
        <Tooltip id="import-tip" />
      </>
    )
  }

  return (
    <>
      <h1>Import from bank / card CSV</h1>
      <form className="card" onSubmit={preview}>
        <div className="grid">
          <div>
            <label htmlFor="imp-file">CSV file</label>
            <input id="imp-file" ref={fileRef} type="file" accept=".csv,text/csv" required />
          </div>
          <div>
            <label htmlFor="imp-account">Account these rows belong to</label>
            <AccountSelect id="imp-account" accounts={accounts.data ?? []} value={accountId} onChange={setAccountId} />
          </div>
          <div>
            <label htmlFor="imp-sign">Single "Amount" column means</label>
            <select id="imp-sign" value={amountSign} onChange={(e) => setAmountSign(e.target.value)}>
              <option value="positive_is_expense">Positive = money out (typical for credit cards)</option>
              <option value="negative_is_expense">Negative = money out (typical for chequing)</option>
            </select>
          </div>
        </div>
        <p className="small muted">
          Supported: TD-style files with no header (date, description, withdrawal, deposit, balance) and files with a
          header row containing Date, Description and Amount, or separate Debit/Credit columns. You will review and fix
          categories before anything is saved; likely duplicates are unticked.
        </p>
        <button type="submit" disabled={busy}>
          Preview
        </button>
      </form>
    </>
  )
}
