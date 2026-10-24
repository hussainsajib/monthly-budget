import { useQuery } from '@tanstack/react-query'
import type { ColumnDef, OnChangeFn, SortingState } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { ColumnFilter } from '../components/ColumnFilter'
import { DataTable } from '../components/DataTable'
import { DateRangeFilter } from '../components/DateRangeFilter'
import { AccountSelect } from '../components/selects'
import { SortHeader } from '../components/table'
import { Loading } from '../components/ui'
import { parseRangeKey, resolveRange, type RangeKey } from '../dateRange'
import { formatMoney } from '../money'
import { useAccounts } from '../queries'
import type { LedgerRow } from '../types'

type FlowKey = 'all' | 'in' | 'out'

const SORTERS: Record<string, (r: LedgerRow) => string | number> = {
  date: (r) => r.date,
  description: (r) => r.description.toLowerCase(),
  in: (r) => Math.max(r.delta_cents, 0),
  out: (r) => Math.max(-r.delta_cents, 0),
  balance: (r) => r.balance_cents,
  bank: (r) => r.bank_balance_cents ?? Number.NEGATIVE_INFINITY,
}

export default function CashflowPage() {
  const accounts = useAccounts()
  const [accountId, setAccountId] = useState<number | null>(null)
  const [sorting, setSorting] = useState<SortingState>([])
  const [params, setParams] = useSearchParams()
  const flow = useQuery({ queryKey: ['cashflow', accountId], queryFn: () => api.cashflow(accountId) })
  const account = flow.data?.account ?? null
  const ledger = flow.data?.ledger ?? null
  const isLoan = account?.is_loan ?? false
  /** A loan reads as amount owed, the inverse of its signed ledger balance. */
  const display = (cents: number) => (isLoan ? -cents : cents)
  const showBank = !isLoan && (ledger?.rows.some((r) => r.bank_balance_cents != null) ?? false)

  const q = params.get('q') ?? ''
  const rangeKey = parseRangeKey(params.get('range'))
  const range = resolveRange(rangeKey, params.get('start') ?? '', params.get('end') ?? '')
  const flowParam = params.get('flow')
  const flowKey: FlowKey = flowParam === 'in' || flowParam === 'out' ? flowParam : 'all'

  const writeParams = (changes: Record<string, string>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v)
          else next.delete(k)
        }
        return next
      },
      { replace: true },
    )
  const applyRange = (key: RangeKey) => writeParams({ range: key === 'all' ? '' : key, start: '', end: '' })
  const applyCustom = (values: { start: string; end: string }) =>
    writeParams({ range: 'custom', start: values.start, end: values.end })

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return [...(ledger?.rows ?? [])].reverse().filter((r) => {
      if (needle && !r.description.toLowerCase().includes(needle)) return false
      if (range.start && r.date < range.start) return false
      if (range.end && r.date > range.end) return false
      if (flowKey === 'in' && r.delta_cents <= 0) return false
      if (flowKey === 'out' && r.delta_cents >= 0) return false
      return true
    })
  }, [ledger, q, range.start, range.end, flowKey])

  const rows = useMemo(() => {
    const sort = sorting[0]
    const key = sort ? SORTERS[sort.id] : undefined
    if (!sort || !key) return filtered
    const sign = sort.desc ? -1 : 1
    return [...filtered].sort((a, b) => {
      const x = key(a)
      const y = key(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sign
    })
  }, [filtered, sorting])

  const onSortingChange: OnChangeFn<SortingState> = (updater) =>
    setSorting((prev) => (typeof updater === 'function' ? updater(prev) : updater))

  const filtering = !!q || rangeKey !== 'all' || flowKey !== 'all'

  const inLabel = isLoan ? 'Paid' : 'In'
  const outLabel = isLoan ? 'Charged' : 'Out'
  const flowFilter = (
    <div className="segmented" role="group" aria-label="Direction">
      {(
        [
          ['all', 'All'],
          ['in', inLabel],
          ['out', outLabel],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={flowKey === key ? 'on' : ''}
          onClick={() => writeParams({ flow: key === 'all' ? '' : key })}
        >
          {label}
        </button>
      ))}
    </div>
  )

  const columns: ColumnDef<LedgerRow>[] = [
    {
      id: 'date',
      accessorFn: (r) => r.date,
      header: ({ column }) => (
        <span className="th-inner">
          <SortHeader column={column} label="Date" />
          <ColumnFilter label="Date" active={rangeKey !== 'all'}>
            <DateRangeFilter
              rangeKey={rangeKey}
              start={range.start}
              end={range.end}
              onRange={applyRange}
              onCustom={applyCustom}
            />
          </ColumnFilter>
        </span>
      ),
      cell: ({ row }) => row.original.date,
    },
    {
      id: 'description',
      accessorFn: (r) => r.description,
      header: ({ column }) => (
        <span className="th-inner">
          <SortHeader column={column} label="Description" />
          <ColumnFilter label="Description" active={!!q}>
            <input
              id="hdr-q"
              type="search"
              aria-label="Search description"
              placeholder="description"
              value={q}
              onChange={(e) => writeParams({ q: e.target.value })}
            />
          </ColumnFilter>
        </span>
      ),
      cell: ({ row }) => (
        <Link to={`/transactions/${row.original.txn_id}`} state={{ from: '/cashflow' }}>
          {row.original.description}
        </Link>
      ),
    },
    {
      id: 'in',
      accessorFn: (r) => r.delta_cents,
      meta: { className: 'num' },
      header: ({ column }) => (
        <span className="th-inner">
          <SortHeader column={column} label={inLabel} />
          <ColumnFilter label={inLabel} active={flowKey !== 'all'}>
            {flowFilter}
          </ColumnFilter>
        </span>
      ),
      cell: ({ row }) => (row.original.delta_cents > 0 ? formatMoney(row.original.delta_cents) : ''),
    },
    {
      id: 'out',
      accessorFn: (r) => r.delta_cents,
      meta: { className: 'num' },
      header: ({ column }) => (
        <span className="th-inner">
          <SortHeader column={column} label={outLabel} />
          <ColumnFilter label={outLabel} active={flowKey !== 'all'}>
            {flowFilter}
          </ColumnFilter>
        </span>
      ),
      cell: ({ row }) => (row.original.delta_cents < 0 ? formatMoney(-row.original.delta_cents) : ''),
    },
    {
      id: 'balance',
      accessorFn: (r) => r.balance_cents,
      meta: { className: 'num' },
      header: ({ column }) => <SortHeader column={column} label={isLoan ? 'Owed' : 'Balance'} />,
      cell: ({ row }) => <b>{formatMoney(display(row.original.balance_cents))}</b>,
    },
    ...(showBank
      ? [
          {
            id: 'bank',
            accessorFn: (r: LedgerRow) => r.bank_balance_cents,
            meta: { className: 'num' },
            header: ({ column }) => <SortHeader column={column} label="Bank" />,
            cell: ({ row }) => {
              const r = row.original
              if (r.bank_balance_cents == null) return ''
              const off = r.bank_balance_cents !== r.balance_cents
              return (
                <span
                  className={off ? 'over' : undefined}
                  title={off ? `Ledger is off by ${formatMoney(r.balance_cents - r.bank_balance_cents)}` : undefined}
                >
                  {formatMoney(r.bank_balance_cents)}
                </span>
              )
            },
          } satisfies ColumnDef<LedgerRow>,
        ]
      : []),
  ]

  return (
    <>
      <h1>Cash flow</h1>

      <div className="row report-head">
        <div className="head-field">
          <label htmlFor="cf-account">Account</label>
          <AccountSelect
            id="cf-account"
            accounts={(accounts.data ?? []).filter((a) => a.is_active)}
            value={accountId ?? account?.id ?? null}
            onChange={setAccountId}
            blank="Choose account…"
            clearable={false}
          />
        </div>
        {account && ledger && (
          <div className="stat">
            <div>
              <span className="muted small">{isLoan ? 'Owed today' : 'Balance today'}</span>
              <b>{formatMoney(display(ledger.current_balance_cents))}</b>
            </div>
            <div>
              <span className="muted small">{isLoan ? 'Owed after planned' : 'After planned items'}</span>
              <b>{formatMoney(display(ledger.projected_balance_cents))}</b>
            </div>
            {ledger.lowest && (
              <div>
                <span className="muted small">{isLoan ? 'Highest owed' : 'Lowest point'}</span>
                <b className={!isLoan && ledger.lowest.level ? 'over' : ''}>
                  {formatMoney(display(ledger.lowest.balance_cents))}
                </b>
                <span className="small muted">
                  {ledger.lowest.date} · {ledger.lowest.description}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <Loading query={flow} />
      {flow.data && !account && (
        <div className="card">
          No accounts yet. <Link to="/settings/accounts">Add one</Link>.
        </div>
      )}

      {account && ledger && (
        <>
          {!account.opening_date && (
            <div className="flash err">
              Set an opening balance and date for <b>{account.name}</b> on the{' '}
              <Link to="/settings/accounts">Accounts</Link> tab; the running balance starts from there.
            </div>
          )}
          <p className="small muted">
            Future-dated transactions (for example from <Link to="/settings/recurring">recurring items</Link>) show as
            planned.
            {isLoan && (
              <>
                {' '}
                Money borrowed on the loan reads as a charge; payments read as paid. See{' '}
                <Link to={`/loans/${account.id}`}>the loan</Link> for its payoff details.
              </>
            )}
          </p>
          <DataTable
            columns={columns}
            data={rows}
            sorting={sorting}
            onSortingChange={onSortingChange}
            getRowId={(r) => String(r.txn_id)}
            rowClassName={(r) => `${isLoan ? '' : r.level} ${r.is_planned ? 'planned' : ''}`}
            emptyMessage={filtering ? 'No transactions match.' : 'No transactions on this account since its opening date.'}
          />
        </>
      )}
    </>
  )
}
