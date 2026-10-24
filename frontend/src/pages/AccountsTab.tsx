import { type ColumnDef, type SortingState } from '@tanstack/react-table'
import { Archive, ArchiveRestore, Pencil, Trash, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { DataTable } from '../components/DataTable'
import { Bar, SortHeader } from '../components/table'
import { Modal, ViewToggle, useViewMode } from '../components/ui'
import { centsToInput, formatMoney } from '../money'
import { useSortedAccounts, useAccountConfig, useLoanTypes } from '../queries'
import { useRun } from '../toast'
import type { Account } from '../types'

interface Draft {
  name: string
  kind: string
  opening_balance: string
  opening_date: string
  is_active: boolean
}

const EMPTY: Draft = { name: '', kind: 'bank', opening_balance: '0', opening_date: '', is_active: true }

const fromAccount = (a: Account): Draft => ({
  name: a.name,
  kind: a.kind,
  opening_balance: centsToInput(a.is_loan ? -a.opening_balance_cents : a.opening_balance_cents),
  opening_date: a.opening_date ?? '',
  is_active: a.is_active,
})

const toBody = (d: Draft) => ({ ...d, opening_date: d.opening_date || null })

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A loan reads as the amount owed (positive), the inverse of its signed ledger balance. */
const displayBalance = (a: Account) => (a.is_loan ? a.owed_cents : a.current_balance_cents)
const displayOpening = (a: Account) => (a.is_loan ? -a.opening_balance_cents : a.opening_balance_cents)

function DraftFields({ draft, onChange, idPrefix }: { draft: Draft; onChange: (d: Draft) => void; idPrefix: string }) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v })
  const types = useAccountConfig().data?.types ?? []
  const isLoan = draft.kind === 'debt'
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-name`}>Name</label>
        <input
          id={`${idPrefix}-name`}
          type="text"
          required
          autoFocus
          maxLength={60}
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-kind`}>Type</label>
        <select id={`${idPrefix}-kind`} value={draft.kind} onChange={(e) => set('kind', e.target.value)}>
          {types.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-bal`}>{isLoan ? 'Opening owed ($)' : 'Opening balance ($)'}</label>
        <input
          id={`${idPrefix}-bal`}
          type="text"
          inputMode="decimal"
          value={draft.opening_balance}
          onChange={(e) => set('opening_balance', e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-date`}>Opening date</label>
        <input
          id={`${idPrefix}-date`}
          type="date"
          value={draft.opening_date}
          onChange={(e) => set('opening_date', e.target.value)}
        />
      </div>
    </>
  )
}

function AccountTile({
  account,
  onEdit,
  onToggle,
}: {
  account: Account
  onEdit: (a: Account) => void
  onToggle: (a: Account) => void
}) {
  const config = useAccountConfig().data
  const typeLabel = account.is_loan
    ? (useLoanTypes().data?.types.find((t) => t.key === account.loan_type)?.label ?? 'Debt / loan')
    : (config?.types.find((t) => t.key === account.kind)?.label ?? account.kind)
  return (
    <article className="tile">
      <div className="tile-head">
        <span className={`kind-dot ${account.kind}`} />
        <span className="tile-name" title={account.name}>
          {account.name}
        </span>
        {!account.is_active && <span className="chip">inactive</span>}
      </div>
      <div className="tile-value">{formatMoney(displayBalance(account))}</div>
      <div className="tile-meta">
        {typeLabel} · opened {account.opening_date ?? '—'}
      </div>
      <div className="tile-foot">
        {account.is_loan ? (
          <Link
            to={`/loans/${account.id}`}
            className="num-link"
            aria-label={`Open the ${account.name} loan`}
            data-tooltip-id="settings-tip"
            data-tooltip-content="Open loan"
          >
            Loan details
          </Link>
        ) : account.transaction_count ? (
          <Link
            to={`/transactions?account_id=${account.id}`}
            className="num-link"
            aria-label={`View ${plural(account.transaction_count, 'transaction')} in ${account.name}`}
            data-tooltip-id="settings-tip"
            data-tooltip-content="View transactions"
          >
            {plural(account.transaction_count, 'transaction')}
          </Link>
        ) : (
          <span className="tile-meta">No transactions</span>
        )}
        <span className="icon-group">
          <button
            type="button"
            className="icon-btn ghost"
            aria-label={account.is_active ? `Archive ${account.name}` : `Restore ${account.name}`}
            data-tooltip-id="settings-tip"
            data-tooltip-content={account.is_active ? 'Archive' : 'Restore'}
            onClick={() => onToggle(account)}
          >
            {account.is_active ? <Archive size={18} /> : <ArchiveRestore size={18} />}
          </button>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label={`Edit ${account.name}`}
            data-tooltip-id="settings-tip"
            data-tooltip-content="Edit"
            onClick={() => onEdit(account)}
          >
            <Pencil size={18} />
          </button>
        </span>
      </div>
    </article>
  )
}

function AccountsTilesSkeleton() {
  return (
    <div className="tile-grid" aria-busy="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div className="tile" key={i}>
          <Bar w={130} />
          <Bar w={92} h={20} />
          <Bar w={150} />
        </div>
      ))}
    </div>
  )
}

export default function AccountsTab() {
  const run = useRun()
  const config = useAccountConfig().data
  const loanTypes = useLoanTypes().data?.types ?? []
  const { view, change: setView } = useViewMode('accounts')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }])
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [modal, setModal] = useState<{ mode: 'add' } | { mode: 'edit'; id: number } | null>(null)
  const [confirming, setConfirming] = useState(false)

  const sort = sorting[0]?.id ?? 'name'
  const dir = sorting[0]?.desc === false ? 'asc' : 'desc'
  const query = useSortedAccounts(sort, dir)
  const accounts = query.data ?? []

  const editing = modal?.mode === 'edit' ? accounts.find((a) => a.id === modal.id) : undefined
  const active = accounts.filter((a) => a.is_active)
  const inactive = accounts.length - active.length
  const activeCash = active.filter((a) => !a.is_loan).reduce((sum, a) => sum + a.current_balance_cents, 0)
  const activeLoans = active.filter((a) => a.is_loan)
  const activeOwed = activeLoans.reduce((sum, a) => sum + a.owed_cents, 0)
  const activeTx = active.reduce((sum, a) => sum + a.transaction_count, 0)
  const typeLabel = (a: Account) =>
    a.is_loan
      ? (loanTypes.find((t) => t.key === a.loan_type)?.label ?? 'Debt / loan')
      : (config?.types.find((t) => t.key === a.kind)?.label ?? a.kind)

  function closeModal() {
    setModal(null)
    setConfirming(false)
  }

  function openAdd() {
    setDraft(EMPTY)
    setConfirming(false)
    setModal({ mode: 'add' })
  }

  function openEdit(a: Account) {
    setDraft(fromAccount(a))
    setConfirming(false)
    setModal({ mode: 'edit', id: a.id })
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (await run(() => api.createAccount(toBody(draft)), `Added ${draft.name.trim()}`)) closeModal()
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    if (await run(() => api.updateAccount(editing.id, toBody(draft)), 'Saved')) closeModal()
  }

  async function destroy() {
    if (!editing) return
    if (await run(() => api.deleteAccount(editing.id).then(() => true), `Deleted ${editing.name}`)) closeModal()
  }

  async function archive() {
    if (!editing) return
    if (await run(() => api.updateAccount(editing.id, toBody({ ...draft, is_active: false })), `Archived ${editing.name}`))
      closeModal()
  }

  const toggleActive = (a: Account) =>
    void run(
      () => api.updateAccount(a.id, toBody({ ...fromAccount(a), is_active: !a.is_active })),
      a.is_active ? `Archived ${a.name}` : `Restored ${a.name}`,
    )

  const columns: ColumnDef<Account>[] = [
    {
      id: 'name',
      meta: { label: 'Name', skeletonWidth: 180 },
      accessorKey: 'name',
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => {
        const a = row.original
        return (
          <span className="row-label">
            <span className="nm">{a.name}</span>
            {!a.is_active && <span className="chip">inactive</span>}
          </span>
        )
      },
    },
    {
      id: 'kind',
      meta: { label: 'Type', skeletonWidth: 90 },
      accessorKey: 'kind',
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => (
        <span className="row-label">
          <span className={`kind-dot ${row.original.kind}`} /> {typeLabel(row.original)}
        </span>
      ),
    },
    {
      id: 'opening',
      meta: { className: 'num', label: 'Opening', skeletonWidth: 96 },
      accessorKey: 'opening_balance_cents',
      header: ({ column }) => <SortHeader column={column} label="Opening" />,
      cell: ({ row }) => formatMoney(displayOpening(row.original)),
    },
    {
      id: 'opening_date',
      meta: { className: 'hide-sm', label: 'Opening date', skeletonWidth: 104 },
      accessorKey: 'opening_date',
      header: ({ column }) => <SortHeader column={column} label="Opening date" />,
      cell: ({ row }) => row.original.opening_date ?? <span className="empty-cell">—</span>,
    },
    {
      id: 'balance',
      meta: { className: 'num', label: 'Balance', skeletonWidth: 104 },
      accessorKey: 'current_balance_cents',
      header: ({ column }) => <SortHeader column={column} label="Balance" />,
      cell: ({ row }) => {
        const a = row.original
        return (
          <span className="row-label">
            <b>{formatMoney(displayBalance(a))}</b>
            {a.is_loan && (
              <Link
                className="chip"
                to={`/loans/${a.id}`}
                aria-label={`Open the ${a.name} loan`}
                data-tooltip-id="settings-tip"
                data-tooltip-content="Open loan"
              >
                owed
              </Link>
            )}
          </span>
        )
      },
    },
    {
      id: 'transactions',
      meta: { className: 'num', label: 'Transactions', skeletonWidth: 80 },
      accessorKey: 'transaction_count',
      header: ({ column }) => <SortHeader column={column} label="Transactions" />,
      cell: ({ row }) => {
        const a = row.original
        if (!a.transaction_count) return <span className="empty-cell">—</span>
        return (
          <Link
            to={`/transactions?account_id=${a.id}`}
            className="num-link"
            aria-label={`View ${plural(a.transaction_count, 'transaction')} in ${a.name}`}
            data-tooltip-id="settings-tip"
            data-tooltip-content="View transactions"
          >
            {a.transaction_count}
          </Link>
        )
      },
    },
    {
      id: 'activity',
      meta: { className: 'num hide-sm', label: 'Activity', skeletonWidth: 96 },
      accessorKey: 'transacted_cents',
      header: ({ column }) => <SortHeader column={column} label="Activity" />,
      cell: ({ row }) =>
        row.original.transacted_cents ? formatMoney(row.original.transacted_cents) : <span className="empty-cell">—</span>,
    },
    {
      id: 'actions',
      enableSorting: false,
      header: () => null,
      cell: ({ row }) => {
        const a = row.original
        return (
          <span className="icon-group">
            <button
              type="button"
              className="icon-btn ghost"
              aria-label={a.is_active ? `Archive ${a.name}` : `Restore ${a.name}`}
              data-tooltip-id="settings-tip"
              data-tooltip-content={a.is_active ? 'Archive' : 'Restore'}
              onClick={() => toggleActive(a)}
            >
              {a.is_active ? <Archive size={18} /> : <ArchiveRestore size={18} />}
            </button>
            <button
              type="button"
              className="icon-btn ghost"
              aria-label={`Edit ${a.name}`}
              data-tooltip-id="settings-tip"
              data-tooltip-content="Edit"
              onClick={() => openEdit(a)}
            >
              <Pencil size={18} />
            </button>
          </span>
        )
      },
    },
  ]

  return (
    <>
      <div className="set-head">
        <h2>Accounts</h2>
        <span className="set-counts">
          <span className="chip">{plural(accounts.length, 'account')}</span>
          <span className="chip">{formatMoney(activeCash)} cash</span>
          {activeOwed > 0 && <span className="chip">{formatMoney(activeOwed)} owed</span>}
          {inactive > 0 && <span className="chip">{inactive} inactive</span>}
        </span>
        <ViewToggle view={view} onChange={setView} />
        <button
          className="push icon-btn ghost"
          type="button"
          aria-label="Add account"
          data-tooltip-id="settings-tip"
          data-tooltip-content="Add account"
          onClick={openAdd}
        >
          <img src="/static/add.svg?v=2" alt="" className="icon-img icon-img-lg" />
        </button>
      </div>

      {modal?.mode === 'add' && (
        <Modal title="Add account" onClose={closeModal}>
          <form onSubmit={add}>
            <div className="form-grid">
              <DraftFields draft={draft} onChange={setDraft} idPrefix="acc-new" />
            </div>
            <p className="small muted">
              Cash flow starts from the opening balance on the opening date, so set both for any account you want a
              running balance for.
            </p>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="shrink with-icon" type="submit">
                <img src="/static/add.svg?v=2" alt="" className="icon-img" /> Add
              </button>
              <button className="secondary shrink with-icon" type="button" onClick={closeModal}>
                <X size={16} /> Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal?.mode === 'edit' && editing && (
        <Modal title={`Edit ${editing.name}`} onClose={closeModal}>
          <form onSubmit={save}>
            <div className="form-grid">
              <DraftFields draft={draft} onChange={setDraft} idPrefix="acc-edit" />
            </div>
            <label className="check">
              <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} />{' '}
              Active — inactive accounts are hidden from pickers but keep their history
            </label>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="shrink with-icon" type="submit">
                <img src="/static/save.svg?v=2" alt="" className="icon-img" /> Save
              </button>
              <button className="secondary shrink with-icon" type="button" onClick={closeModal}>
                <X size={16} /> Cancel
              </button>
            </div>

            <div className="danger-zone">
              <h2>Delete</h2>
              {confirming ? (
                <div className="confirm-box">
                  <p>
                    Delete <b>{editing.name}</b>?
                    {editing.transaction_count > 0
                      ? ` Its ${plural(editing.transaction_count, 'transaction')} stay in your ledger but lose this account.`
                      : ' It has nothing attached, so this cannot be undone.'}
                  </p>
                  <div className="row">
                    <button className="danger shrink with-icon" type="button" onClick={destroy}>
                      <Trash size={16} /> Delete
                    </button>
                    <button className="secondary shrink" type="button" onClick={() => setConfirming(false)}>
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="small muted">
                    {editing.transaction_count > 0
                      ? `Its ${plural(editing.transaction_count, 'transaction')} stay in your ledger but lose this account.`
                      : 'Nothing is attached to this account.'}
                  </p>
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="secondary shrink with-icon" type="button" onClick={() => void archive()}>
                      <Archive size={16} /> Archive instead
                    </button>
                    <button className="danger shrink with-icon" type="button" onClick={() => setConfirming(true)}>
                      <Trash size={16} /> Delete account
                    </button>
                  </div>
                </>
              )}
            </div>
          </form>
        </Modal>
      )}

      {query.isError && <div className="flash err">{query.error?.message ?? 'Failed to load'}</div>}

      {query.isPending ? (
        view === 'card' ? (
          <AccountsTilesSkeleton />
        ) : (
          <DataTable columns={columns} data={[]} loading />
        )
      ) : accounts.length === 0 ? (
        <div className="card">
          <p className="muted">No accounts yet. Add one to start tracking balances and cash flow.</p>
        </div>
      ) : view === 'card' ? (
        <div className="tile-grid">
          {accounts.map((a) => (
            <AccountTile key={a.id} account={a} onEdit={openEdit} onToggle={toggleActive} />
          ))}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={accounts}
          sorting={sorting}
          onSortingChange={setSorting}
          footer={
            <>
              <tr className="total-row">
                <td colSpan={4}>{plural(active.length, 'active account')}</td>
                <td className="num">{formatMoney(activeCash)}</td>
                <td className="num">{activeTx || <span className="empty-cell">—</span>}</td>
                <td className="num hide-sm" />
              </tr>
              {activeLoans.length > 0 && (
                <tr className="total-row">
                  <td colSpan={4}>Owed on {plural(activeLoans.length, 'loan')}</td>
                  <td className="num">{formatMoney(activeOwed)}</td>
                  <td className="num" />
                  <td className="num hide-sm" />
                </tr>
              )}
            </>
          }
        />
      )}
    </>
  )
}
