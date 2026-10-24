import { type ColumnDef, type SortingState } from '@tanstack/react-table'
import { HandCoins, Pencil } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Tooltip } from 'react-tooltip'
import { Tooltip as ChartTip, ResponsiveContainer, Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { DataTable } from '../components/DataTable'
import { Bar, SortHeader } from '../components/table'
import { LoanFormModal, LoanPaymentModal } from '../components/LoanForm'
import { ViewToggle, useViewMode } from '../components/ui'
import { formatMoney, monthLabel } from '../money'
import { useLoans } from '../queries'
import type { Loan, LoanTypeTotal, LoanTrendPoint } from '../types'

const REVIEW_KEY = 'mb-loan-review-dismissed'

function readDismissed() {
  try {
    return localStorage.getItem(REVIEW_KEY) === '1'
  } catch {
    return false
  }
}

function storeDismissed() {
  try {
    localStorage.setItem(REVIEW_KEY, '1')
  } catch {
    return
  }
}

const compact = (cents: number) => (Math.abs(cents) >= 100000 ? `$${Math.round(cents / 100000)}k` : formatMoney(cents))

const owedDollars = (v: unknown) => formatMoney(Math.round(Number(v)))

const tooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  color: 'var(--ink)',
}

const payoffPct = (loan: Loan) => Math.max(0, Math.min(100, loan.payoff_pct))

function Payoff({ loan }: { loan: Loan }) {
  return (
    <span className="payoff-cell">
      <span className="progress">
        <span style={{ width: `${payoffPct(loan)}%` }} />
      </span>
      <span className="small muted">{payoffPct(loan)}%</span>
    </span>
  )
}

const rateLabel = (loan: Loan) => (loan.rate_pct ? `${loan.rate_pct}%` : '—')

const dueLabel = (loan: Loan) => {
  if (loan.next_due_date) return loan.next_due_date
  if (loan.due_day) return `day ${loan.due_day}`
  return '—'
}

function typeChip(t: LoanTypeTotal) {
  return (
    <span key={t.key || 'none'} className="chip">
      {t.label} · {formatMoney(t.owed_cents)}
    </span>
  )
}

function TrendChart({ trend }: { trend: LoanTrendPoint[] }) {
  const data = trend.map((p) => ({ label: monthLabel(p.month), owed: p.owed_cents }))
  return (
    <div className="card">
      <h2>Total debt</h2>
      <div className="chart-box" style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="label" stroke="var(--muted)" tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis
              tickFormatter={(v) => compact(Number(v))}
              stroke="var(--muted)"
              tickLine={false}
              axisLine={false}
              width={60}
            />
            <ChartTip formatter={owedDollars} contentStyle={tooltipStyle} />
            <Area
              type="monotone"
              dataKey="owed"
              stroke="var(--series-2)"
              fill="var(--series-2)"
              fillOpacity={0.12}
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="small muted">Amount owed at each month end, oldest to newest.</p>
    </div>
  )
}

function LoanTile({ loan }: { loan: Loan }) {
  return (
    <Link className="tile" to={`/loans/${loan.account_id}`}>
      <span className="tile-head">
        <span className={`kind-dot ${loan.kind}`} />
        <span className="tile-name">{loan.name}</span>
        {!loan.is_active && <span className="chip">inactive</span>}
      </span>
      <span className="tile-value">{formatMoney(loan.owed_cents)}</span>
      <span className="tile-meta">
        {loan.loan_type_label}
        {loan.lender ? ` · ${loan.lender}` : ''}
      </span>
      <span className="progress">
        <span style={{ width: `${payoffPct(loan)}%` }} />
      </span>
      <span className="tile-meta">
        {payoffPct(loan)}% paid off
        {loan.min_payment_cents ? ` · ${formatMoney(loan.min_payment_cents)}/mo` : ''}
        {loan.residual_cents > 0 ? ` · ${formatMoney(loan.residual_cents)} balloon` : ''}
      </span>
    </Link>
  )
}

export default function LoansPage() {
  const navigate = useNavigate()
  const { view, change: setView } = useViewMode('loans')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'owed', desc: true }])
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Loan | null>(null)
  const [paying, setPaying] = useState<Loan | null>(null)
  const [dismissed, setDismissed] = useState(readDismissed)

  const sort = sorting[0]?.id ?? 'owed'
  const dir = sorting[0]?.desc === false ? 'asc' : 'desc'
  const query = useLoans(sort, dir)
  const loans = query.data?.items ?? []
  const totals = query.data?.totals
  const trend = query.data?.trend ?? []
  const missing = query.data?.missing_details ?? []

  const closeForms = () => {
    setCreating(false)
    setEditing(null)
  }
  const saved = (id: number) => {
    closeForms()
    navigate(`/loans/${id}`)
  }

  const columns: ColumnDef<Loan>[] = [
    {
      id: 'name',
      meta: { label: 'Name', skeletonWidth: 180 },
      accessorKey: 'name',
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => {
        const l = row.original
        return (
          <span className="row-label">
            <span className={`kind-dot ${l.kind}`} />
            <Link className="nm" to={`/loans/${l.account_id}`}>
              {l.name}
            </Link>
            {!l.is_active && <span className="chip">inactive</span>}
          </span>
        )
      },
    },
    {
      id: 'type',
      meta: { label: 'Type', skeletonWidth: 90 },
      accessorKey: 'loan_type_label',
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => row.original.loan_type_label,
    },
    {
      id: 'lender',
      meta: { className: 'num hide-sm', label: 'Lender', skeletonWidth: 110 },
      accessorKey: 'lender',
      header: ({ column }) => <SortHeader column={column} label="Lender" />,
      cell: ({ row }) => row.original.lender || <span className="empty-cell">—</span>,
    },
    {
      id: 'owed',
      meta: { className: 'num', label: 'Owed', skeletonWidth: 90 },
      accessorKey: 'owed_cents',
      header: ({ column }) => <SortHeader column={column} label="Owed" />,
      cell: ({ row }) => <b>{formatMoney(row.original.owed_cents)}</b>,
    },
    {
      id: 'rate',
      meta: { className: 'num hide-sm', label: 'Rate', skeletonWidth: 60 },
      accessorKey: 'rate_bps',
      header: ({ column }) => <SortHeader column={column} label="Rate" />,
      cell: ({ row }) => rateLabel(row.original),
    },
    {
      id: 'payoff',
      meta: { className: 'num', label: 'Payoff', skeletonWidth: 130 },
      accessorKey: 'payoff_pct',
      header: ({ column }) => <SortHeader column={column} label="Payoff" />,
      cell: ({ row }) => <Payoff loan={row.original} />,
    },
    {
      id: 'payment',
      meta: { className: 'num hide-sm', label: 'Payment', skeletonWidth: 90 },
      accessorKey: 'min_payment_cents',
      header: ({ column }) => <SortHeader column={column} label="Payment" />,
      cell: ({ row }) =>
        row.original.min_payment_cents ? formatMoney(row.original.min_payment_cents) : <span className="empty-cell">—</span>,
    },
    {
      id: 'due',
      meta: { className: 'num hide-sm', label: 'Due', skeletonWidth: 90 },
      accessorKey: 'due_day',
      header: ({ column }) => <SortHeader column={column} label="Due" />,
      cell: ({ row }) => dueLabel(row.original),
    },
    {
      id: 'actions',
      enableSorting: false,
      header: () => null,
      cell: ({ row }) => {
        const l = row.original
        return (
          <span className="icon-group">
            <button
              type="button"
              className="icon-btn ghost"
              aria-label={`Record a payment to ${l.name}`}
              data-tooltip-id="loans-tip"
              data-tooltip-content="Record payment"
              onClick={() => setPaying(l)}
            >
              <HandCoins size={18} />
            </button>
            <button
              type="button"
              className="icon-btn ghost"
              aria-label={`Edit ${l.name}`}
              data-tooltip-id="loans-tip"
              data-tooltip-content="Edit"
              onClick={() => setEditing(l)}
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
        <h1>Loans</h1>
        <span className="set-counts">
          {totals && <span className="chip">{totals.count} {totals.count === 1 ? 'loan' : 'loans'}</span>}
          {totals && totals.owed_cents > 0 && <span className="chip">Owed {formatMoney(totals.owed_cents)}</span>}
          {totals && totals.principal_paid_cents > 0 && (
            <span className="chip">{formatMoney(totals.principal_paid_cents)} paid off</span>
          )}
        </span>
        <ViewToggle view={view} onChange={setView} tooltipId="loans-tip" />
        <button
          className="push icon-btn ghost"
          type="button"
          aria-label="Add loan"
          data-tooltip-id="loans-tip"
          data-tooltip-content="Add loan"
          onClick={() => setCreating(true)}
        >
          <img src="/static/add.svg?v=2" alt="" className="icon-img icon-img-lg" />
        </button>
      </div>

      {query.isError && <div className="flash err">{query.error?.message ?? 'Failed to load'}</div>}

      {!dismissed && missing.length > 0 && (
        <div className="flash info flash-row">
          <span>
            {missing.length === 1 ? 'One account is' : `${missing.length} accounts are`} now tracked as loans.{' '}
            Add their details to see payoff, interest and due dates.
          </span>
          <span className="row-actions">
            {missing.map((m) => {
              const loan = loans.find((l) => l.account_id === m.account_id)
              return (
                <button
                  key={m.account_id}
                  type="button"
                  className="link-button"
                  disabled={!loan}
                  onClick={() => loan && setEditing(loan)}
                >
                  {m.name}
                </button>
              )
            })}
            <button
              type="button"
              className="secondary small"
              onClick={() => {
                storeDismissed()
                setDismissed(true)
              }}
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      {query.isPending ? (
        view === 'card' ? (
          <div className="tile-grid" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div className="tile" key={i}>
                <Bar w={140} />
                <Bar w={92} h={20} />
                <Bar w={160} />
              </div>
            ))}
          </div>
        ) : (
          <DataTable columns={columns} data={[]} loading />
        )
      ) : (
        <>
          {totals && totals.count > 0 && (
            <div className="card stat">
              <div>
                <span className="muted small">Total owed</span>
                <b>{formatMoney(totals.owed_cents)}</b>
              </div>
              <div>
                <span className="muted small">Original</span>
                <b>{formatMoney(totals.original_cents)}</b>
              </div>
              {totals.residual_cents > 0 && (
                <div>
                  <span className="muted small">Balloons</span>
                  <b>{formatMoney(totals.residual_cents)}</b>
                </div>
              )}
              <div>
                <span className="muted small">Paid off</span>
                <b>{formatMoney(totals.principal_paid_cents)}</b>
              </div>
            </div>
          )}

          {totals && totals.by_type.length > 0 && (
            <p className="filter-chips">{totals.by_type.map(typeChip)}</p>
          )}

          {trend.some((p) => p.owed_cents !== 0) && <TrendChart trend={trend} />}

          {loans.length === 0 ? (
            <div className="card">
              <p className="muted">
                No loans yet. Add one to track a mortgage, car loan, credit card or anything else you owe.
              </p>
            </div>
          ) : view === 'card' ? (
            <div className="tile-grid">
              {loans.map((l) => (
                <LoanTile key={l.account_id} loan={l} />
              ))}
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={loans}
              sorting={sorting}
              onSortingChange={setSorting}
              footer={
                <>
                  <tr className="total-row">
                    <td colSpan={3}>{loans.length} shown</td>
                    <td className="num">{formatMoney(loans.reduce((s, l) => s + l.owed_cents, 0))}</td>
                    <td className="num hide-sm" />
                    <td className="num" />
                    <td className="num hide-sm" />
                    <td className="num hide-sm" />
                    <td />
                  </tr>
                </>
              }
            />
          )}
        </>
      )}

      {creating && <LoanFormModal onClose={closeForms} onSaved={saved} />}
      {editing && <LoanFormModal loan={editing} onClose={closeForms} onSaved={saved} />}
      {paying && <LoanPaymentModal loan={paying} onClose={() => setPaying(null)} onSaved={() => setPaying(null)} />}
      <Tooltip id="loans-tip" />
    </>
  )
}
