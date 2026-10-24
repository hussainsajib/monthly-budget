import { useQuery } from '@tanstack/react-query'
import { type ColumnDef, type OnChangeFn, type SortingState } from '@tanstack/react-table'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Tooltip } from 'react-tooltip'
import { api } from '../api'
import { DEFAULT_LEVELS, isIncomeKind } from '../categoryConfig'
import { AccountSelect, CategoryFilter, OptionSelect } from '../components/selects'
import { DataTable } from '../components/DataTable'
import { SortHeader } from '../components/table'
import TransferForm, { type TransferFormValues } from '../components/TransferForm'
import TxnForm, { type TxnFormValues } from '../components/TxnForm'
import { ColumnFilter } from '../components/ColumnFilter'
import { Modal } from '../components/ui'
import { DateRangeFilter } from '../components/DateRangeFilter'
import { RANGE_OPTIONS, parseRangeKey, resolveRange, type RangeKey } from '../dateRange'
import { formatMoney, todayIso } from '../money'
import { useAccounts, useCategories, useCategoryConfig, useImportCategories } from '../queries'
import { useRun } from '../toast'
import type { Txn } from '../types'

const FILTER_KEYS = ['q', 'start', 'end', 'category_id', 'account_id', 'range'] as const
type FilterKey = (typeof FILTER_KEYS)[number]

const blankForm = (date: string): TxnFormValues => ({
  date,
  description: '',
  category_id: null,
  account_id: null,
  amount: '',
  notes: '',
})

const blankTransfer = (date: string): TransferFormValues => ({
  date,
  description: '',
  amount: '',
  from_account_id: null,
  to_account_id: null,
  notes: '',
})

export default function TransactionsPage() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const run = useRun()
  const categories = useCategories()
  const filterCategories = useImportCategories()
  const config = useCategoryConfig().data
  const accounts = useAccounts()
  const descriptions = useQuery({ queryKey: ['transactions', 'descriptions'], queryFn: api.descriptions })
  const [initial, setInitial] = useState<TxnFormValues>(() => blankForm(todayIso()))
  const [adding, setAdding] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [customRange, setCustomRange] = useState<{ start: string; end: string } | null>(null)
  const [sorting, setSorting] = useState<SortingState>([{ id: 'date', desc: true }])
  const [addMode, setAddMode] = useState<'txn' | 'transfer'>('txn')
  const [transferInitial, setTransferInitial] = useState<TransferFormValues>(() => blankTransfer(todayIso()))
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [converting, setConverting] = useState<Txn | null>(null)
  const [convertingLoanId, setConvertingLoanId] = useState<number | null>(null)

  const sort = sorting[0]?.id ?? 'date'
  const dir = sorting[0] && sorting[0].desc === false ? 'asc' : 'desc'

  const filters = Object.fromEntries([...FILTER_KEYS, 'page'].map((k) => [k, params.get(k) ?? '']))
  const rangeKey = parseRangeKey(filters.range)
  const rangeDatesValue = resolveRange(rangeKey, filters.start, filters.end)
  const serverQuery = {
    q: filters.q,
    start: rangeDatesValue.start,
    end: rangeDatesValue.end,
    category_id: filters.category_id,
    account_id: filters.account_id,
    page: filters.page,
  }
  const list = useQuery({
    queryKey: ['transactions', 'list', serverQuery, sort, dir],
    queryFn: () => api.transactions({ ...serverQuery, sort, dir }),
  })

  const categoryById = new Map((categories.data ?? []).map((c) => [c.id, c]))
  const accountById = new Map((accounts.data ?? []).map((a) => [a.id, a]))

  // Filter edits live in the URL so a filtered view can be linked to (the Categories tab does this).
  const [draft, setDraft] = useState(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])))
  const setField = (k: FilterKey, v: string) => setDraft((d) => ({ ...d, [k]: v }))

  const writeParam = (k: FilterKey, v: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (v) next.set(k, v)
      else next.delete(k)
      next.delete('page') // a filter change starts back on page 1
      return next
    })

  // Main-page filters apply live; the advanced modal's Apply commits the rest.
  const applyField = (k: FilterKey, v: string) => {
    setField(k, v)
    writeParam(k, v)
  }
  const clearField = (k: FilterKey) => applyField(k, '')

  const applyRange = (key: RangeKey) => {
    setField('range', key === 'all' ? '' : key)
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('page')
      if (key === 'all') {
        next.delete('range')
        next.delete('start')
        next.delete('end')
      } else {
        next.set('range', key)
        if (key !== 'custom') {
          next.delete('start')
          next.delete('end')
        }
      }
      return next
    })
  }
  const applyRangeCustom = (values: { start: string; end: string }) => {
    setField('range', 'custom')
    setField('start', values.start)
    setField('end', values.end)
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('range', 'custom')
      if (values.start) next.set('start', values.start)
      else next.delete('start')
      if (values.end) next.set('end', values.end)
      else next.delete('end')
      next.delete('page')
      return next
    })
    setCustomRange(null)
  }
  const searchTimer = useRef<number | undefined>(undefined)
  const onSearchChange = (v: string) => {
    setField('q', v)
    window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => writeParam('q', v), 300)
  }

  const applyFilters = () => {
    const next = new URLSearchParams()
    for (const k of FILTER_KEYS) if (draft[k]) next.set(k, draft[k])
    setParams(next)
  }
  const clearFilters = () => {
    setDraft(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])))
    setParams(new URLSearchParams())
  }
  const goToPage = (page: number) => {
    const next = new URLSearchParams(params)
    next.set('page', String(page))
    setParams(next)
  }
  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    setSorting((prev) => (typeof updater === 'function' ? updater(prev) : updater))
    const next = new URLSearchParams(params)
    next.delete('page') // a new sort starts back on page 1
    setParams(next)
  }

  const items = list.data?.items ?? []
  const from = location.pathname + location.search

  // Drop any selection that fell off the page (re-filter, new page, refresh).
  useEffect(() => {
    setSelected((prev) => {
      const keep = new Set(prev)
      for (const id of prev) if (!items.some((i) => i.id === id)) keep.delete(id)
      return keep.size === prev.size ? prev : keep
    })
  }, [items])

  const selectedItems = items.filter((i) => selected.has(i.id))
  const deltaOf = (t: Txn) => (isIncomeKind(config, t.kind) ? t.amount_cents : -t.amount_cents)
  const a = selectedItems[0]
  const b = selectedItems[1]
  const da = a ? deltaOf(a) : 0
  const db = b ? deltaOf(b) : 0
  const connectable =
    selectedItems.length === 2 &&
    da !== 0 &&
    db !== 0 &&
    Math.sign(da) !== Math.sign(db) &&
    Math.abs(da) === Math.abs(db) &&
    a.account_id != null &&
    b.account_id != null &&
    a.account_id !== b.account_id
  const connectFromId = da < 0 ? a?.id : b?.id
  const connectToId = da < 0 ? b?.id : a?.id

  const toggleSelected = (id: number, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  async function connectTransfer() {
    if (!connectable || connectFromId == null || connectToId == null) return
    const ok = await run(
      () => api.connectTransfer(connectFromId, connectToId).then((r) => r.transfer_id),
      () => 'Connected as a transfer',
    )
    if (ok) setSelected(new Set())
  }

  const connectableReimbursement =
    selectedItems.length === 2 &&
    da !== 0 &&
    db !== 0 &&
    Math.sign(da) !== Math.sign(db) &&
    Math.abs(da) === Math.abs(db) &&
    a?.kind === 'reimbursement' &&
    b?.kind === 'reimbursement' &&
    a.reimbursement_id == null &&
    b.reimbursement_id == null

  async function connectReimbursement() {
    if (!connectableReimbursement || !a || !b) return
    const ok = await run(
      () => api.connectReimbursement(a.id, b.id).then((r) => r.reimbursement_id),
      () => 'Connected as a reimbursement',
    )
    if (ok) setSelected(new Set())
  }

  const loanAccounts = (accounts.data ?? []).filter((x) => x.is_loan && x.is_active)
  const single = selectedItems.length === 1 ? selectedItems[0] : undefined
  const convertible =
    single != null &&
    single.account_id != null &&
    single.transfer_id == null &&
    single.reimbursement_id == null &&
    deltaOf(single) < 0

  async function convertToLoanPayment() {
    if (!converting || convertingLoanId == null) return
    const ok = await run(
      () => api.convertToLoanPayment(convertingLoanId, converting.id).then((r) => r.transfer_id),
      () => `Recorded a payment to ${accountById.get(convertingLoanId)?.name ?? 'the loan'}`,
    )
    if (ok) {
      setConverting(null)
      setSelected(new Set())
    }
  }

  const chips: { key: string; label: string; clear: () => void }[] = []
  if (filters.q) chips.push({ key: 'q', label: `Search: ${filters.q}`, clear: () => clearField('q') })
  if (rangeKey !== 'all') {
    const label =
      rangeKey === 'custom' ? `Date: ${filters.start || '…'} – ${filters.end || '…'}` : `Date: ${RANGE_OPTIONS.find((o) => o.key === rangeKey)?.full ?? ''}`
    chips.push({ key: 'range', label, clear: () => applyRange('all') })
  }
  if (filters.category_id) {
    const c = categoryById.get(Number(filters.category_id))
    chips.push({ key: 'category_id', label: `Category: ${c ? c.path : filters.category_id}`, clear: () => clearField('category_id') })
  }
  if (filters.account_id) {
    const a = accountById.get(Number(filters.account_id))
    chips.push({ key: 'account_id', label: `Account: ${a ? a.name : filters.account_id}`, clear: () => clearField('account_id') })
  }

  const allLevels = (config?.levels.length ? config.levels : DEFAULT_LEVELS) ?? DEFAULT_LEVELS
  const levels = allLevels.length > 3 ? allLevels.slice(0, 3) : allLevels
  const filterCategoryById = new Map((filterCategories.data ?? []).map((c) => [c.id, c]))
  const activeCategory = filters.category_id ? filterCategoryById.get(Number(filters.category_id)) : undefined
  const categoryColumns: ColumnDef<Txn>[] = levels.map((label, i) => ({
    id: `category_${i}`,
    meta: { width: '12%', className: 'trunc', label },
    enableSorting: false,
    header: () => (
      <span className="th-inner">
        <span>{label}</span>
        <ColumnFilter label={label} active={!!activeCategory && activeCategory.depth >= i}>
          <CategoryFilter
            id={`hdr-cat-${i}`}
            categories={filterCategories.data ?? []}
            value={filters.category_id}
            onChange={(v) => applyField('category_id', v)}
            levelFrom={i}
            levelTo={i}
          />
        </ColumnFilter>
      </span>
    ),
    cell: ({ row }) => row.original.category_path?.split(' › ')[i] ?? '',
  }))

  const columns: ColumnDef<Txn>[] = [
    {
      id: 'select',
      meta: { width: '36px', className: 'select-col', skeletonWidth: 16 },
      enableSorting: false,
      header: () => (
        <input
          type="checkbox"
          aria-label="Select all on this page"
          checked={items.length > 0 && items.every((i) => selected.has(i.id))}
          onChange={(e) =>
            setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())
          }
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={`Select ${row.original.description}`}
          checked={selected.has(row.original.id)}
          onChange={(e) => toggleSelected(row.original.id, e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      ),
    },
    {
      id: 'date',
      meta: { width: '9%', label: 'Date', skeletonWidth: 70 },
      accessorKey: 'date',
      header: ({ column }) => (
        <span className="th-inner">
          <SortHeader column={column} label="Date" />
          <ColumnFilter label="Date" active={rangeKey !== 'all'}>
            <DateRangeFilter
              rangeKey={rangeKey}
              start={rangeDatesValue.start}
              end={rangeDatesValue.end}
              onRange={applyRange}
              onCustom={applyRangeCustom}
            />
          </ColumnFilter>
        </span>
      ),
      cell: ({ row }) => row.original.date,
    },
    {
      id: 'description',
      meta: { label: 'Description', skeletonWidth: 240 },
      accessorKey: 'description',
      header: ({ column }) => (
        <span className="th-inner">
          <SortHeader column={column} label="Description" />
          <ColumnFilter label="Description" active={!!filters.q}>
            <input
              id="hdr-q"
              type="search"
              aria-label="Search description or notes"
              placeholder="description or notes"
              value={draft.q}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </ColumnFilter>
        </span>
      ),
      cell: ({ row }) => (
        <>
          {row.original.description}
          {row.original.planned && <span className="chip">planned</span>}
          {row.original.reimbursement_id && <span className="chip">reimbursed</span>}
          {row.original.recurring_description && <span className="chip">recurring · {row.original.recurring_description}</span>}
        </>
      ),
    },
    ...categoryColumns,
    {
      id: 'account',
      meta: { width: '12%', className: 'hide-sm trunc', label: 'Account' },
      accessorKey: 'account_name',
      header: ({ column }) => (
        <span className="th-inner">
          <SortHeader column={column} label="Account" />
          <ColumnFilter label="Account" active={!!filters.account_id}>
            <AccountSelect
              id="hdr-acc"
              accounts={accounts.data ?? []}
              value={filters.account_id ? Number(filters.account_id) : null}
              onChange={(id) => applyField('account_id', id === null ? '' : String(id))}
              blank="All accounts"
            />
          </ColumnFilter>
        </span>
      ),
      cell: ({ row }) => (
        <>
          {row.original.account_name ?? '—'}
          {row.original.transfer_account_name && (
            <span className="chip">{row.original.transfer_account_name}</span>
          )}
        </>
      ),
    },
    {
      id: 'amount',
      meta: { width: '10%', className: 'num', label: 'Amount' },
      accessorKey: 'amount_cents',
      header: ({ column }) => <SortHeader column={column} label="Amount" />,
      cell: ({ row }) => (
        <span className={isIncomeKind(config, row.original.kind) ? 'under' : ''}>
          {formatMoney(row.original.amount_cents)}
        </span>
      ),
    },
  ]

  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>
          Transactions <span className="chip">{list.data?.total ?? '…'}</span>
        </h1>
        <span className="row-actions">
          <button
            className="icon-btn ghost"
            type="button"
            aria-label="Add transaction"
            data-tooltip-id="txn-tip"
            data-tooltip-content="Add transaction"
            onClick={() => setAdding(true)}
          >
            <img src="/static/add.svg?v=2" alt="" className="icon-img icon-img-lg" />
          </button>
          <button
            className="icon-btn ghost"
            type="button"
            aria-label="Import a bank/card CSV"
            data-tooltip-id="txn-tip"
            data-tooltip-content="Import a bank/card CSV"
            onClick={() => navigate('/import')}
          >
            <img src="/static/upload.svg?v=3" alt="" className="icon-img icon-img-lg" />
          </button>
        </span>
      </div>

      <form
        className="filter-bar"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="row">
          <div className="field-search">
            <label htmlFor="flt-q">Search</label>
            <input
              id="flt-q"
              type="search"
              placeholder="description or notes"
              value={draft.q}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
          <div className="date-range">
            <label htmlFor="flt-range">Date range</label>
            <OptionSelect
              id="flt-range"
              label="Date range"
              value={rangeKey}
              options={RANGE_OPTIONS.map((o) => ({ value: o.key, label: o.full }))}
              onChange={(v) => {
                if (v === 'custom') setCustomRange({ start: draft.start, end: draft.end })
                else applyRange(v as RangeKey)
              }}
            />
          </div>
          <div className="field-cat">
            <CategoryFilter
              id="flt-cat"
              categories={filterCategories.data ?? []}
              value={filters.category_id}
              onChange={(v) => applyField('category_id', v)}
              levelTo={1}
            />
          </div>
          <span className="btn-pair">
            <button
              className="icon-btn ghost"
              type="button"
              aria-label="Advanced filters"
              data-tooltip-id="txn-tip"
              data-tooltip-content="Advanced filters"
              onClick={() => setAdvanced(true)}
            >
              <img src="/static/filter.svg?v=3" alt="" className="icon-img icon-img-lg" />
            </button>
            <button
              className="icon-btn ghost"
              type="button"
              aria-label="Clear filters"
              data-tooltip-id="txn-tip"
              data-tooltip-content="Clear filters"
              onClick={clearFilters}
            >
              <img src="/static/clear.svg?v=5" alt="" className="icon-img icon-img-lg" />
            </button>
          </span>
        </div>
        <div className="filter-chips">
            {chips.map((c) => (
              <button key={c.key} type="button" className="chip chip-clear" onClick={c.clear}>
                {c.label}
                <X size={13} />
              </button>
            ))}
          {chips.length > 0 && (
            <button type="button" className="link-button" onClick={clearFilters}>
              Clear all
            </button>
          )}
        </div>
      </form>

      {advanced && (
        <Modal title="Advanced filters" onClose={() => setAdvanced(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              applyFilters()
              setAdvanced(false)
            }}
          >
            <div className="grid">
              <div className="field-cat">
                <CategoryFilter
                  id="flt-cat"
                  categories={filterCategories.data ?? []}
                  value={draft.category_id}
                  onChange={(v) => setField('category_id', v)}
                  levelFrom={2}
                />
              </div>
              <div>
                <label htmlFor="flt-acc">Account</label>
                <AccountSelect
                  id="flt-acc"
                  accounts={accounts.data ?? []}
                  value={draft.account_id ? Number(draft.account_id) : null}
                  onChange={(id) => setField('account_id', id === null ? '' : String(id))}
                  blank="All accounts"
                />
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="secondary shrink"
                type="button"
                onClick={() => {
                  clearFilters()
                  setAdvanced(false)
                }}
              >
                Clear all
              </button>
              <button className="shrink push" type="submit">
                Apply filters
              </button>
            </div>
          </form>
        </Modal>
      )}

      {customRange && (
        <div className="modal-overlay center" onClick={() => setCustomRange(null)}>
          <div
            className="range-pop"
            role="dialog"
            aria-label="Custom date range"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row">
              <div className="date-field">
                <label htmlFor="flt-start">From</label>
                <input
                  id="flt-start"
                  type="date"
                  value={customRange.start}
                  onChange={(e) => {
                    const n = { ...customRange, start: e.target.value }
                    setCustomRange(n)
                    if (n.start && n.end) applyRangeCustom(n)
                  }}
                />
              </div>
              <div className="date-field">
                <label htmlFor="flt-end">To</label>
                <input
                  id="flt-end"
                  type="date"
                  value={customRange.end}
                  onChange={(e) => {
                    const n = { ...customRange, end: e.target.value }
                    setCustomRange(n)
                    if (n.start && n.end) applyRangeCustom(n)
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {list.isError && <div className="flash err">{list.error?.message ?? 'Failed to load'}</div>}
      {selected.size > 0 && (
        <div className="row table-toolbar" style={{ alignItems: 'center' }}>
          <span className="small muted">{selected.size} selected</span>
          {selectedItems.length === 2 && !connectable && !connectableReimbursement && (
            <span className="small muted">
              Pick one money-out and one money-in for the same amount: on two different accounts for a
              transfer, or both tagged Reimbursable for a reimbursement (your outlay + the repayment).
            </span>
          )}
          <span className="push" />
          {selectedItems.length === 2 && connectable && (
            <button type="button" className="shrink" onClick={connectTransfer}>
              Connect as transfer
            </button>
          )}
          {selectedItems.length === 2 && connectableReimbursement && (
            <button type="button" className="secondary shrink" onClick={connectReimbursement}>
              Connect as reimbursement
            </button>
          )}
          {convertible && (
            <button
              type="button"
              className="secondary shrink"
              onClick={() => {
                setConvertingLoanId(null)
                setConverting(single ?? null)
              }}
            >
              As loan payment
            </button>
          )}
          <button type="button" className="secondary small shrink" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      <DataTable
        columns={columns}
        data={items}
        sorting={sorting}
        onSortingChange={onSortingChange}
        loading={list.isPending}
        emptyMessage="No transactions match."
        onRowClick={(t) => navigate(`/transactions/${t.id}`, { state: { from } })}
        rowAriaLabel={(t) => `Edit ${t.description}`}
        rowClassName={(t) => (t.planned ? 'planned' : '')}
        pagination={list.data ? { pageCount: list.data.pages, page: list.data.page, onPageChange: goToPage } : undefined}
      />

      {adding && (
        <Modal title="Add transaction" onClose={() => setAdding(false)}>
          <div className="segmented" role="group" aria-label="Entry type">
            <button type="button" className={addMode === 'txn' ? 'on' : ''} onClick={() => setAddMode('txn')}>
              Transaction
            </button>
            <button type="button" className={addMode === 'transfer' ? 'on' : ''} onClick={() => setAddMode('transfer')}>
              Transfer
            </button>
          </div>
          {addMode === 'txn' ? (
            <TxnForm
              big
              initial={initial}
              descriptions={descriptions.data ?? []}
              submitLabel="Add"
              findDuplicates={(v) =>
                api.transactionDuplicates({ date: v.date, amount: v.amount, account_id: v.account_id })
              }
              onSubmit={async (v) => {
                const created = await run(
                  () => api.createTransaction(v),
                  (t) => `Added ${t.description}`,
                )
                if (created) {
                  setAdding(false)
                  setInitial(blankForm(todayIso()))
                }
              }}
            />
          ) : (
            <TransferForm
              big
              initial={transferInitial}
              submitLabel="Add"
              onSubmit={async (v) => {
                const created = await run(
                  () => api.createTransfer(v).then((r) => r.transfer_id),
                  () => 'Added transfer',
                )
                if (created) {
                  setAdding(false)
                  setTransferInitial(blankTransfer(todayIso()))
                }
              }}
            />
          )}
        </Modal>
      )}

      {converting && (
        <Modal title="Record as a loan payment" onClose={() => setConverting(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void convertToLoanPayment()
            }}
          >
            <p className="small muted">
              Turn this row — <b>{converting.description}</b> ({formatMoney(converting.amount_cents)}) — into a
              payment on a loan. It stays put on {converting.account_name ?? 'its account'}; the matching leg is
              written onto the loan.
            </p>
            <div className="form-grid">
              <div className="field-full">
                <label htmlFor="convert-loan">Pays</label>
                <AccountSelect
                  id="convert-loan"
                  accounts={loanAccounts}
                  value={convertingLoanId}
                  onChange={setConvertingLoanId}
                  blank="Choose a loan…"
                />
              </div>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="shrink" type="submit" disabled={convertingLoanId == null}>
                Record payment
              </button>
              <button className="secondary shrink" type="button" onClick={() => setConverting(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}

      <Tooltip id="txn-tip" />
    </>
  )
}