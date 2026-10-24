import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Receipt } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Tooltip } from 'react-tooltip'
import { api } from '../api'
import { NetWaterfall } from '../components/NetWaterfall'
import { Bar } from '../components/table'
import { Loading } from '../components/ui'
import { formatMoney, monthLabel, todayIso } from '../money'
import type { NetBreakdownRow } from '../types'

interface TreeNode {
  row: NetBreakdownRow
  children: TreeNode[]
  differs: boolean
}

function buildTree(rows: NetBreakdownRow[]): TreeNode[] {
  const roots: TreeNode[] = []
  const stack: TreeNode[] = []
  for (const row of rows) {
    const node: TreeNode = { row, children: [], differs: row.effect_cents !== 0 }
    while (stack.length && stack[stack.length - 1].row.depth >= row.depth) stack.pop()
    if (stack.length) stack[stack.length - 1].children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  const settle = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      settle(n.children)
      if (n.children.some((c) => c.differs)) n.differs = true
    }
    nodes.sort((a, b) => Math.abs(b.row.effect_cents) - Math.abs(a.row.effect_cents))
  }
  settle(roots)
  return roots
}

const signed = (cents: number) => (cents === 0 ? '' : `${cents > 0 ? '+' : ''}${formatMoney(cents)}`)
const tone = (cents: number) => (cents === 0 ? '' : cents > 0 ? 'under' : 'over')

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0)
  const lastIso = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`
  const today = todayIso()
  return { start: `${month}-01`, end: lastIso > today ? today : lastIso }
}

function CategoryTransactions({ month, categoryId }: { month: string; categoryId: number }) {
  const txns = useQuery({ queryKey: ['net-txns', month, categoryId], queryFn: () => api.netTransactions(month, categoryId) })
  if (txns.isPending) {
    return (
      <div className="loading-skeleton" aria-busy="true">
        <Bar w={260} />
        <Bar w={200} />
      </div>
    )
  }
  if (txns.isError) return <div className="flash err">{txns.error?.message ?? 'Failed to load'}</div>
  if (txns.data.length === 0) return <p className="small muted">No transactions counted this month.</p>
  return (
    <table className="net-txns">
      <tbody>
        {txns.data.map((t) => (
          <tr key={t.id}>
            <td>{t.date}</td>
            <td>
              <Link to={`/transactions/${t.id}`} state={{ from: `/reports/net/${month}` }}>
                {t.description}
              </Link>
            </td>
            <td className="muted">{t.category_path}</td>
            <td className="muted">{t.account_name ?? '—'}</td>
            <td className="num">{formatMoney(t.amount_cents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function NetRow({
  row,
  month,
  range,
  hasKids,
  folded,
  isOpen,
  onFold,
  onOpen,
}: {
  row: NetBreakdownRow
  month: string
  range: { start: string; end: string }
  hasKids: boolean
  folded: boolean
  isOpen: boolean
  onFold: () => void
  onOpen: () => void
}) {
  return (
    <>
      <tr className={row.depth === 0 ? 'root' : ''}>
        <td>
          <span className={`row-label cat-d${row.depth}`}>
            {hasKids ? (
              <button
                type="button"
                className="twist"
                aria-expanded={!folded}
                aria-label={`${folded ? 'Expand' : 'Collapse'} ${row.name}`}
                onClick={onFold}
              >
                {folded ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              </button>
            ) : (
              <span className="twist-spacer" />
            )}
            <span className="nm">{row.name}</span>
          </span>
        </td>
        <td className="num muted">{formatMoney(row.budget_cents, true)}</td>
        <td className="num">{formatMoney(row.actual_cents, true)}</td>
        <td className={`num ${tone(row.effect_cents)}`}>{signed(row.effect_cents)}</td>
        <td className="num">
          <span className="icon-group">
            <button
              type="button"
              className="icon-btn ghost"
              aria-label={`Show transactions for ${row.name}`}
              aria-expanded={isOpen}
              data-tooltip-id="net-tip"
              data-tooltip-content="Show transactions"
              onClick={onOpen}
            >
              <Receipt size={16} />
            </button>
            <Link
              className="icon-btn ghost"
              aria-label={`View ${row.name} in Transactions`}
              data-tooltip-id="net-tip"
              data-tooltip-content="View in Transactions"
              to={`/transactions?category_id=${row.category_id}&range=custom&start=${range.start}&end=${range.end}`}
            >
              <ExternalLink size={16} />
            </Link>
          </span>
        </td>
      </tr>
      {isOpen && (
        <tr className="net-detail">
          <td colSpan={5}>
            <CategoryTransactions month={month} categoryId={row.category_id} />
          </td>
        </tr>
      )}
    </>
  )
}

export default function NetBreakdownPage() {
  const { month = '' } = useParams()
  const [onlyDiff, setOnlyDiff] = useState(true)
  const [collapsedState, setCollapsed] = useState<Set<number> | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const query = useQuery({ queryKey: ['net-breakdown', month], queryFn: () => api.netBreakdown(month) })
  const d = query.data
  const tree = useMemo(() => buildTree(d?.rows ?? []), [d])
  const collapsed = useMemo(() => {
    if (collapsedState) return collapsedState
    const ids = new Set<number>()
    const collect = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.children.length) ids.add(n.row.category_id)
        collect(n.children)
      }
    }
    collect(tree)
    return ids
  }, [collapsedState, tree])

  const toggle = (set: Set<number>, id: number, apply: (s: Set<number>) => void) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    apply(next)
  }

  const flat: TreeNode[] = []
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (onlyDiff && !n.differs) continue
      flat.push(n)
      if (!collapsed.has(n.row.category_id)) walk(n.children)
    }
  }
  walk(tree)

  const range = monthRange(month)

  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>
          <Link to="/reports" className="small">
            Report
          </Link>{' '}
          / NET — {d ? monthLabel(d.month, true) : month}
        </h1>
        <span className="row-actions">
          {d?.previous ? (
            <Link className="icon-btn ghost" to={`/reports/net/${d.previous}`} aria-label={`Previous month, ${monthLabel(d.previous, true)}`}>
              <ChevronLeft size={20} />
            </Link>
          ) : (
            <span className="icon-btn ghost disabled" aria-hidden="true">
              <ChevronLeft size={20} />
            </span>
          )}
          {d?.next ? (
            <Link className="icon-btn ghost" to={`/reports/net/${d.next}`} aria-label={`Next month, ${monthLabel(d.next, true)}`}>
              <ChevronRight size={20} />
            </Link>
          ) : (
            <span className="icon-btn ghost disabled" aria-hidden="true">
              <ChevronRight size={20} />
            </span>
          )}
        </span>
      </div>

      <Loading query={query} />
      {d && (
        <>
          <div className="card">
            <div className="stat">
              <div>
                <span className="muted small">Budget NET</span>
                <b>{formatMoney(d.net_budget)}</b>
              </div>
              <div>
                <span className="muted small">Actual NET</span>
                <b>{formatMoney(d.net_actual)}</b>
              </div>
              <div>
                <span className="muted small">Difference</span>
                <b className={tone(d.net_diff)}>{d.net_diff === 0 ? formatMoney(0) : signed(d.net_diff)}</b>
              </div>
              <div>
                <span className="muted small">Income</span>
                <b>{formatMoney(d.income_actual)}</b>
                <span className="muted small">of {formatMoney(d.income_budget)} budgeted</span>
              </div>
              <div>
                <span className="muted small">Expenses</span>
                <b>{formatMoney(d.expense_actual)}</b>
                <span className="muted small">of {formatMoney(d.expense_budget)} budgeted</span>
              </div>
            </div>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>How the difference adds up</h2>
            <NetWaterfall
              budget={d.net_budget}
              actual={d.net_actual}
              steps={tree.filter((n) => n.row.effect_cents !== 0).map((n) => ({ name: n.row.name, effect_cents: n.row.effect_cents }))}
            />
          </div>

          <div className="row" style={{ alignItems: 'center' }}>
            <label className="check-inline">
              <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Only categories with a difference
            </label>
          </div>

          <div className="card table-wrap">
            <table className="net-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Budget</th>
                  <th className="num">Actual</th>
                  <th className="num">Effect on NET</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {flat.map(({ row, children }) => (
                  <NetRow
                    key={row.category_id}
                    row={row}
                    month={d.month}
                    range={range}
                    hasKids={children.length > 0}
                    folded={collapsed.has(row.category_id)}
                    isOpen={open.has(row.category_id)}
                    onFold={() => toggle(collapsed, row.category_id, setCollapsed)}
                    onOpen={() => toggle(open, row.category_id, setOpen)}
                  />
                ))}
                {flat.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Every category matched its budget this month.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="total-row">
                  <td>NET (income − expenses)</td>
                  <td className="num">{formatMoney(d.net_budget)}</td>
                  <td className="num">{formatMoney(d.net_actual)}</td>
                  <td className={`num ${tone(d.net_diff)}`}>{signed(d.net_diff)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="small muted">
            Effect on NET is positive when a category helped (income above budget, spending below budget). Actual excludes
            future-dated entries and paired transfers or reimbursements.
          </p>
        </>
      )}
      <Tooltip id="net-tip" />
    </>
  )
}
