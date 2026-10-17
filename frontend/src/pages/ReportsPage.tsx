import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api'
import { Loading } from '../components/ui'
import { formatMoney, monthLabel } from '../money'
import type { ReportRow } from '../types'

const dollars = (v: unknown) => formatMoney(Math.round(Number(v) * 100))

export default function ReportsPage() {
  const [month, setMonth] = useState<number | null>(null) // null = last month with activity
  const [collapsed, setCollapsed] = useState<Set<number> | null>(null)
  const report = useQuery({
    queryKey: ['report', month],
    queryFn: () => api.report(month),
    placeholderData: keepPreviousData,
  })
  const r = report.data
  // A window that crosses new year needs years on the column headers to stay unambiguous.
  const withYear = r ? new Set(r.months.map((m) => m.slice(0, 4))).size > 1 : false
  const range = r ? `${monthLabel(r.months[0], true)} to ${monthLabel(r.months[r.months.length - 1], true)}` : ''
  const selected = r?.month ?? 1
  const collapsedIds = collapsed ?? new Set((r?.rows ?? []).filter((row) => row.has_children).map((row) => row.category_id))

  const toggle = (categoryId: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev ?? collapsedIds)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })

  const visibleRows: ReportRow[] = []
  let hideDepth: number | null = null
  for (const row of r?.rows ?? []) {
    if (hideDepth !== null && row.depth > hideDepth) continue
    hideDepth = null
    visibleRows.push(row)
    if (collapsedIds.has(row.category_id)) hideDepth = row.depth
  }

  return (
    <>
      <h1>Budget tracker{range ? ` — ${range}` : ''}</h1>

      <div className="card row">
        <div>
          <label htmlFor="rep-month">Month for category chart</label>
          <select
            id="rep-month"
            value={r?.month ?? ''}
            onChange={(e) => setMonth(Number(e.target.value))}
          >
            {(r?.months ?? []).map((m, i) => (
              <option key={m} value={i + 1}>
                {monthLabel(m, true)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Loading query={report} />
      {r && (
        <>
          <div className="card stat">
            <div>
              <span className="muted small">Avg monthly spending</span>
              <b>{formatMoney(r.avg_expense)}</b>
            </div>
            <div>
              <span className="muted small">Monthly budget</span>
              <b>{formatMoney(r.expense_budget)}</b>
            </div>
            <div>
              <span className="muted small">Net in window</span>
              <b className={sum(r.net_months) >= 0 ? 'under' : 'over'}>{formatMoney(sum(r.net_months))}</b>
            </div>
          </div>

          <div className="charts">
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Spending vs income by month</h2>
              <div className="chart-box">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={r.months.map((m, i) => ({ month: monthLabel(m, withYear), Spending: r.chart.spending[i], Income: r.chart.income[i] }))}>
                    <CartesianGrid stroke="var(--line)" vertical={false} />
                    <XAxis dataKey="month" stroke="var(--muted)" />
                    <YAxis stroke="var(--muted)" />
                    <Tooltip formatter={dollars} contentStyle={tooltipStyle} />
                    <Legend />
                    <Bar dataKey="Spending" fill="var(--series-2)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Income" fill="var(--series-1)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>{monthLabel(r.months[selected - 1], true)}: top categories vs budget</h2>
              <div className="chart-box">
                {r.chart.categories.length === 0 ? (
                  <p className="muted">No spending in {monthLabel(r.months[selected - 1], true)}.</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      layout="vertical"
                      data={r.chart.categories.map((c, i) => ({
                        category: c,
                        Actual: r.chart.category_actual[i],
                        Budget: r.chart.category_budget[i],
                      }))}
                    >
                      <CartesianGrid stroke="var(--line)" horizontal={false} />
                      <XAxis type="number" stroke="var(--muted)" />
                      <YAxis type="category" dataKey="category" width={130} stroke="var(--muted)" />
                      <Tooltip formatter={dollars} contentStyle={tooltipStyle} />
                      <Legend />
                      <Bar dataKey="Actual" fill="var(--series-2)" radius={[0, 3, 3, 0]} />
                      <Bar dataKey="Budget" fill="var(--track)" radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          <h2>Category × month</h2>
          <div className="card table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th rowSpan={2}>Category</th>
                  {r.months.map((m) => (
                    <th key={m} className="num" colSpan={2}>
                      {monthLabel(m, withYear)}
                    </th>
                  ))}
                </tr>
                <tr>
                  {r.months.map((m) => (
                    <Fragment key={m}>
                      <th className="num sub">Budget</th>
                      <th className="num sub">Actual</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const hidden = collapsedIds.has(row.category_id)
                  return (
                    <tr key={row.category_id} className={row.depth === 0 ? 'root' : ''}>
                      <td>
                        <span className={`row-label cat-d${row.depth}`}>
                          {row.has_children ? (
                            <button
                              type="button"
                              className="twist"
                              aria-expanded={!hidden}
                              aria-label={`${hidden ? 'Expand' : 'Collapse'} ${row.name}`}
                              onClick={() => toggle(row.category_id)}
                            >
                              {hidden ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                            </button>
                          ) : (
                            <span className="twist-spacer" />
                          )}
                          <span className="nm">{row.name}</span>
                        </span>
                      </td>
                      {row.months.map((c, i) => (
                        <Fragment key={i}>
                          <td className="num muted">{formatMoney(row.budgets[i], true)}</td>
                          <td className={`num ${tone(c, row.budgets[i], !row.is_income)}`}>
                            {formatMoney(c, true)}
                          </td>
                        </Fragment>
                      ))}
                    </tr>
                  )
                })}
                <tr className="root">
                  <td>NET (income − expenses)</td>
                  {r.net_months.map((c, i) => (
                    <Fragment key={i}>
                      <td className="num muted">{formatMoney(r.net_budgets[i], true)}</td>
                      <td className={`num ${tone(c, r.net_budgets[i], false)}`}>{formatMoney(c, true)}</td>
                    </Fragment>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Budget is the effective monthly budget (defaults plus any override for that month); Actual excludes
            future-dated entries. Parent budgets are the sum of their sub-categories.
          </p>
        </>
      )}
    </>
  )
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** 'over' (red) when in the red, 'under' (green) when ahead, '' when equal. expense=true means over budget is bad. */
const tone = (actual: number, budget: number, expense = true) => {
  if (actual === budget) return ''
  const good = expense ? actual < budget : actual > budget
  return good ? 'under' : 'over'
}

const tooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  color: 'var(--ink)',
}