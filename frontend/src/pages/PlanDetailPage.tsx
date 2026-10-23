import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash, X } from 'lucide-react'
import { api } from '../api'
import { formatMoney, monthLabel, todayIso } from '../money'
import { useAccounts, useCategories, usePlan, usePlanTypes } from '../queries'
import { useRun } from '../toast'
import type { Plan, PlanEvent, PlanItem, PlanItemBody, PlanSavingsCategory } from '../types'
import { PlanFormModal } from '../components/PlanForm'
import { AccountSelect, CategorySelect } from '../components/selects'
import { Modal, Loading } from '../components/ui'

interface ItemDraft {
  date: string
  description: string
  category_id: number | null
  account_id: number | null
  amount: string
  direction: 'in' | 'out'
  item_kind: string
}

const EMPTY_ITEM: ItemDraft = {
  date: todayIso(),
  description: '',
  category_id: null,
  account_id: null,
  amount: '',
  direction: 'out',
  item_kind: 'custom',
}

function toItemDraft(item: PlanItem): ItemDraft {
  return {
    date: item.date ?? '',
    description: item.description,
    category_id: item.category_id,
    account_id: item.account_id,
    amount: (item.amount_cents / 100).toFixed(2),
    direction: item.direction,
    item_kind: item.item_kind,
  }
}

function ItemModal({
  plan,
  item,
  onClose,
  onSaved,
}: {
  plan: Plan
  item?: PlanItem
  onClose: () => void
  onSaved: () => void
}) {
  const run = useRun()
  const categories = useCategories().data ?? []
  const accounts = useAccounts().data ?? []
  const planType = (usePlanTypes().data ?? []).find((t) => t.key === plan.type)
  const kinds = planType?.item_kinds ?? ['custom']
  const [draft, setDraft] = useState<ItemDraft>(item ? toItemDraft(item) : { ...EMPTY_ITEM, item_kind: kinds[0] })
  const set = <K extends keyof ItemDraft>(k: K, v: ItemDraft[K]) => setDraft((d) => ({ ...d, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const body: PlanItemBody = {
      date: draft.date || null,
      description: draft.description,
      category_id: draft.category_id,
      account_id: draft.account_id,
      amount: draft.amount,
      direction: draft.direction,
      item_kind: draft.item_kind,
      matched_transaction_id: item?.matched_transaction_id ?? null,
    }
    const result = await run(
      () =>
        item
          ? api.updatePlanItem(plan.id, item.id, body).then(() => true)
          : api.createPlanItem(plan.id, body).then(() => true),
      item ? 'Item saved' : 'Item added',
    )
    if (result) onSaved()
  }

  return (
    <Modal title={item ? 'Edit item' : 'Add item'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div>
            <label htmlFor="pi-desc">Description</label>
            <input
              id="pi-desc"
              type="text"
              maxLength={200}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="pi-amount">Amount ($)</label>
            <input
              id="pi-amount"
              type="text"
              inputMode="decimal"
              required
              value={draft.amount}
              onChange={(e) => set('amount', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="pi-date">Date</label>
            <input id="pi-date" type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} />
          </div>
          <div>
            <label htmlFor="pi-dir">Direction</label>
            <select id="pi-dir" value={draft.direction} onChange={(e) => set('direction', e.target.value as 'in' | 'out')}>
              <option value="out">Money out</option>
              <option value="in">Money in</option>
            </select>
          </div>
          <div>
            <label htmlFor="pi-kind">Kind</label>
            <select id="pi-kind" value={draft.item_kind} onChange={(e) => set('item_kind', e.target.value)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="field-full">
            <label htmlFor="pi-cat">Category (optional, enables matching)</label>
            <CategorySelect
              id="pi-cat"
              categories={categories}
              value={draft.category_id}
              onChange={(id) => set('category_id', id)}
              blank="— none —"
            />
          </div>
          <div className="field-full">
            <label htmlFor="pi-acc">Account (optional)</label>
            <AccountSelect
              id="pi-acc"
              accounts={accounts}
              value={draft.account_id}
              onChange={(id) => set('account_id', id)}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="shrink" type="submit">
            {item ? 'Save item' : 'Add item'}
          </button>
          <button className="secondary shrink with-icon" type="button" onClick={onClose}>
            <X size={16} /> Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}

function RollingSummary({ plan }: { plan: Plan }) {
  const d = plan.derived
  const low = (d.lowest_balance_cents ?? 0) < 0
  const variable = d.variable_spending_cents ?? 0
  return (
    <div className="card stat">
      <div>
        <span className="muted small">Safe to spend</span>
        <b className={d.safe_to_spend_cents != null && d.safe_to_spend_cents < 0 ? 'over' : ''}>
          {formatMoney(d.safe_to_spend_cents ?? 0)}
        </b>
        {d.paycheck ? <span className="small muted">from {d.paycheck.description}</span> : null}
        {variable ? <span className="small muted">after {formatMoney(variable)} variable spending</span> : null}
        {d.buffer_cents ? <span className="small muted">after a {formatMoney(d.buffer_cents)} buffer</span> : null}
      </div>
      <div>
        <span className="muted small">Inflow</span>
        <b>{formatMoney(d.inflow_cents ?? 0)}</b>
      </div>
      <div>
        <span className="muted small">Outflow</span>
        <b>{formatMoney(d.outflow_cents ?? 0)}</b>
      </div>
      <div>
        <span className="muted small">Variable</span>
        <b>{formatMoney(variable)}</b>
        {d.variable_category_count ? <span className="small muted">{d.variable_category_count} categories</span> : null}
      </div>
      <div>
        <span className="muted small">End balance</span>
        <b className={low ? 'over' : ''}>{formatMoney(d.end_balance_cents ?? 0)}</b>
        <span className="small muted">
          low {formatMoney(d.lowest_balance_cents ?? 0)} · through {d.window?.end}
        </span>
      </div>
    </div>
  )
}

function GoalSummary({ plan }: { plan: Plan }) {
  const d = plan.derived
  const pct = Math.max(0, Math.min(100, d.progress_pct ?? 0))
  return (
    <div className="card">
      <div className="stat">
        <div>
          <span className="muted small">Funded</span>
          <b>{formatMoney(d.funded_cents ?? 0)}</b>
        </div>
        <div>
          <span className="muted small">Remaining</span>
          <b>{formatMoney(d.remaining_cents ?? 0)}</b>
        </div>
        <div>
          <span className="muted small">Target</span>
          <b>{formatMoney(d.target_cents ?? 0)}</b>
          {d.target_date ? <span className="small muted">by {d.target_date}</span> : null}
        </div>
        {d.required_monthly_cents != null && (
          <div>
            <span className="muted small">Needed / month</span>
            <b>{formatMoney(d.required_monthly_cents)}</b>
            {d.months_remaining ? <span className="small muted">{d.months_remaining} months left</span> : null}
          </div>
        )}
      </div>
      <div className="progress" style={{ marginTop: 12 }}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function SavingsSummary({ plan }: { plan: Plan }) {
  const d = plan.derived
  const pct = Math.max(0, Math.min(100, d.progress_pct ?? 0))
  const under = d.underspend_cents ?? 0
  const net = d.net_cents ?? 0
  const categories = d.categories ?? []
  const months = d.months ?? []
  const hasActual = months.some((m) => m.kind === 'actual')
  return (
    <>
      <div className="card stat">
        <div>
          <span className="muted small">Free to save</span>
          <b className={net < 0 ? 'over' : ''}>{formatMoney(net)}</b>
          <span className="small muted">
            {d.window ? `${monthLabel(d.window.start)}–${monthLabel(d.window.end, true)}` : ''} · income minus spending
          </span>
        </div>
        <div>
          <span className="muted small">Under budget</span>
          <b className={under < 0 ? 'over' : 'under'}>{formatMoney(under)}</b>
          <span className="small muted">spent less than planned</span>
        </div>
        <div>
          <span className="muted small">Set aside</span>
          <b>{formatMoney(d.funded_cents ?? 0)}</b>
          {d.target_date ? <span className="small muted">by {d.target_date}</span> : null}
        </div>
        <div>
          <span className="muted small">Target</span>
          <b>{formatMoney(d.target_cents ?? 0)}</b>
          <span className="small muted">{formatMoney(d.remaining_cents ?? 0)} to go</span>
        </div>
        {d.required_monthly_cents != null && (
          <div>
            <span className="muted small">Needed / month</span>
            <b>{formatMoney(d.required_monthly_cents)}</b>
            {d.months_remaining ? <span className="small muted">{d.months_remaining} months left</span> : null}
          </div>
        )}
      </div>
      <div className="progress" style={{ marginTop: 12 }}>
        <span style={{ width: `${pct}%` }} />
      </div>

      {months.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Income</th>
                <th className="num">Spending</th>
                <th className="num">Free</th>
                <th className="num">Running</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} className={m.kind === 'projected' ? 'planned' : ''}>
                  <td>
                    {monthLabel(m.month, true)}
                    <span className="chip">{m.kind === 'actual' ? 'actual' : 'planned'}</span>
                  </td>
                  <td className="num money">{formatMoney(m.income_cents)}</td>
                  <td className="num money">{formatMoney(m.expense_cents)}</td>
                  <td className={`num money ${m.net_cents < 0 ? 'over' : 'under'}`}>{formatMoney(m.net_cents)}</td>
                  <td className={`num money ${m.cumulative_cents < 0 ? 'over' : ''}`}>{formatMoney(m.cumulative_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {categories.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Spending by category{hasActual ? ' (elapsed months)' : ''}</th>
                <th className="num">Budget</th>
                <th className="num">Spent</th>
                <th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c: PlanSavingsCategory) => {
                const diff = c.remaining_cents
                return (
                  <tr key={c.category_id} className={c.has_children ? 'root' : ''}>
                    <td style={{ paddingLeft: `calc(10px + ${c.depth} * var(--tree-indent, 18px))` }}>{c.name}</td>
                    <td className="num money">{formatMoney(c.budget_cents, true)}</td>
                    <td className="num money">{formatMoney(c.actual_cents, true)}</td>
                    <td className={`num money ${diff < 0 ? 'over' : diff > 0 ? 'under' : ''}`}>{formatMoney(diff)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function FundingActivity({ plan }: { plan: Plan }) {
  const f = plan.derived.funding
  if (!f) return null
  return (
    <>
      <h2>Funding activity</h2>
      <p className="small muted">
        {f.account_name
          ? `Money reaching ${f.account_name} funds the goal; money leaving it is spent.`
          : 'Every transaction in the funding category counts toward the goal. Set a target account to split funding from spending.'}
      </p>
      <div className="card stat">
        <div>
          <span className="muted small">Set aside</span>
          <b className={f.net_cents < 0 ? 'over' : ''}>{formatMoney(f.net_cents)}</b>
          <span className="small muted">{f.category_path}</span>
        </div>
        <div>
          <span className="muted small">In</span>
          <b className="under">{formatMoney(f.in_cents)}</b>
        </div>
        <div>
          <span className="muted small">Out</span>
          <b className="over">{formatMoney(f.out_cents)}</b>
        </div>
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Account</th>
              <th className="num">Amount</th>
              <th className="num">Effect</th>
            </tr>
          </thead>
          <tbody>
            {f.transactions.map((t) => (
              <tr key={t.id}>
                <td>{t.date}</td>
                <td>{t.description}</td>
                <td className="muted">{t.account_name ?? '—'}</td>
                <td className="num money">{formatMoney(t.amount_cents)}</td>
                <td className={`num money ${t.signed_cents < 0 ? 'over' : 'under'}`}>
                  {t.signed_cents < 0 ? '-' : '+'}
                  {formatMoney(Math.abs(t.signed_cents))}
                </td>
              </tr>
            ))}
            {f.transactions.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No funding transactions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function DebtSummary({ plan }: { plan: Plan }) {
  const d = plan.derived
  const schedule = (d.schedule ?? []).slice(0, 24)
  return (
    <>
      <div className="card stat">
        <div>
          <span className="muted small">Monthly payment</span>
          <b>{formatMoney(d.monthly_payment_cents ?? 0)}</b>
          {d.apr_pct ? <span className="small muted">{d.apr_pct}% APR</span> : null}
        </div>
        <div>
          <span className="muted small">Payoff in</span>
          <b>{d.months_to_payoff != null ? `${d.months_to_payoff} mo` : '—'}</b>
        </div>
        <div>
          <span className="muted small">Total interest</span>
          <b>{formatMoney(d.total_interest_cents ?? 0)}</b>
        </div>
        <div>
          <span className="muted small">Debts</span>
          <b>{(d.debts ?? []).length}</b>
        </div>
      </div>
      {(d.debts ?? []).length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Debt</th>
                <th className="num">Balance</th>
                <th className="num">Interest</th>
                <th className="num">Paid off</th>
              </tr>
            </thead>
            <tbody>
              {(d.debts ?? []).map((debt) => (
                <tr key={debt.id}>
                  <td>{debt.name}</td>
                  <td className="num money">{formatMoney(debt.initial_cents)}</td>
                  <td className="num money">{formatMoney(debt.interest_cents)}</td>
                  <td className="num muted">{debt.payoff_month != null ? `month ${debt.payoff_month}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {schedule.length > 0 && (
        <>
          <h2>Balance over time</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="num">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((row) => (
                  <tr key={row.month}>
                    <td>{row.month}</td>
                    <td className="num money">{formatMoney(row.remaining_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(d.schedule ?? []).length > schedule.length && (
            <p className="small muted">Showing the first {schedule.length} months.</p>
          )}
        </>
      )}
    </>
  )
}

function EventSummary({ plan }: { plan: Plan }) {
  const d = plan.derived
  const budget = d.budget_cents ?? 0
  const pct = budget > 0 ? Math.max(0, Math.min(100, ((d.estimate_cents ?? 0) / budget) * 100)) : 0
  const over = (d.remaining_cents ?? 0) < 0
  return (
    <div className="card">
      <div className="stat">
        <div>
          <span className="muted small">Budget</span>
          <b>{formatMoney(budget)}</b>
        </div>
        <div>
          <span className="muted small">Estimated</span>
          <b>{formatMoney(d.estimate_cents ?? 0)}</b>
        </div>
        <div>
          <span className="muted small">{over ? 'Over by' : 'Left'}</span>
          <b className={over ? 'over' : 'under'}>{formatMoney(Math.abs(d.remaining_cents ?? 0))}</b>
        </div>
      </div>
      {budget > 0 && (
        <div className="progress" style={{ marginTop: 12 }}>
          <span style={{ width: `${pct}%`, background: over ? 'var(--bad)' : undefined }} />
        </div>
      )}
    </div>
  )
}

function ScenarioSummary({ plan }: { plan: Plan }) {
  const d = plan.derived
  const rows: { label: string; base: number; adjusted: number }[] = [
    { label: 'Income', base: d.base_income_cents ?? 0, adjusted: d.income_cents ?? 0 },
    { label: 'Expenses', base: d.base_expense_cents ?? 0, adjusted: d.expense_cents ?? 0 },
    { label: 'Net', base: d.base_net_cents ?? 0, adjusted: d.net_cents ?? 0 },
  ]
  return (
    <div className="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>{d.month}</th>
            <th className="num">Base</th>
            <th className="num">
              Adjusted{d.income_adjust_pct || d.expense_adjust_pct ? ` (${d.income_adjust_pct}% in / ${d.expense_adjust_pct}% out)` : ''}
            </th>
            <th className="num">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className="num money">{formatMoney(r.base)}</td>
              <td className="num money">{formatMoney(r.adjusted)}</td>
              <td className={`num money ${r.adjusted - r.base < 0 ? 'over' : 'under'}`}>
                {formatMoney(r.adjusted - r.base)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AffordabilitySummary({ plan }: { plan: Plan }) {
  const d = plan.derived
  return (
    <>
      <div className={`flash ${d.affordable ? 'ok' : 'err'}`}>
        {d.affordable
          ? `Yes — you can afford ${formatMoney(d.purchase_cents ?? 0)} on ${d.purchase_date}.`
          : `No — short by ${formatMoney(d.shortfall_cents ?? 0)} on ${d.purchase_date}.`}
      </div>
      <div className="card stat">
        <div>
          <span className="muted small">Purchase</span>
          <b>{formatMoney(d.purchase_cents ?? 0)}</b>
          {d.account_name ? <span className="small muted">{d.account_name}</span> : null}
        </div>
        <div>
          <span className="muted small">Balance before</span>
          <b>{formatMoney(d.balance_before_cents ?? 0)}</b>
        </div>
        <div>
          <span className="muted small">Balance after</span>
          <b className={d.affordable ? '' : 'over'}>{formatMoney(d.balance_after_cents ?? 0)}</b>
        </div>
      </div>
    </>
  )
}

function EventsTable({ events }: { events: PlanEvent[] }) {
  const today = todayIso()
  const nextIndex = events.findIndex((e) => e.date != null && e.date >= today)
  return (
    <div className="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th>Category</th>
            <th className="num">Planned</th>
            <th className="num">Actual</th>
            <th className="num">Variance</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => {
            const planned = e.direction === 'in' ? e.amount_cents : -e.amount_cents
            const actual = e.actual_cents
            const variance = e.variance_cents
            const isNext = i === nextIndex
            const classes = [e.matched_transaction_id ? '' : 'planned', isNext ? 'next' : ''].filter(Boolean).join(' ')
            return (
              <tr key={e.item_id ?? `${e.source}-${e.ref_id}-${i}`} className={classes}>
                <td>
                  {e.date ?? '—'}
                  {isNext && <span className="chip event-next-chip">next</span>}
                </td>
                <td>{e.description}</td>
                <td className="muted">{e.category_path || '—'}</td>
                <td className="num money">{formatMoney(planned)}</td>
                <td className="num money">{actual == null ? '—' : formatMoney(actual)}</td>
                <td className={`num money ${variance ? (variance > 0 ? 'over' : 'under') : ''}`}>
                  {variance == null ? '—' : formatMoney(variance)}
                </td>
                <td className={`num money ${e.balance_cents != null && e.balance_cents < 0 ? 'over' : ''}`}>
                  {e.balance_cents == null ? '—' : formatMoney(e.balance_cents)}
                </td>
              </tr>
            )
          })}
          {events.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Nothing scheduled in this window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export default function PlanDetailPage() {
  const { id } = useParams()
  const planId = Number(id)
  const navigate = useNavigate()
  const run = useRun()
  const queryClient = useQueryClient()
  const query = usePlan(planId)
  const [editing, setEditing] = useState(false)
  const [itemModal, setItemModal] = useState<{ item?: PlanItem } | null>(null)

  const plan = query.data
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['plan', planId] })
    void queryClient.invalidateQueries({ queryKey: ['plans'] })
  }

  async function destroy() {
    if (!plan) return
    const done = await run(() => api.deletePlan(plan.id).then(() => true), `Deleted ${plan.name}`)
    if (done) {
      void queryClient.invalidateQueries({ queryKey: ['plans'] })
      navigate('/plan')
    }
  }

  async function removeItem(item: PlanItem) {
    if (!plan) return
    const done = await run(() => api.deletePlanItem(plan.id, item.id).then(() => true), 'Item removed')
    if (done) refresh()
  }

  return (
    <>
      <p className="small muted">
        <Link to="/plan">← Plan</Link>
      </p>
      <Loading query={query} />

      {plan && (
        <>
          <div className="set-head">
            <h1>{plan.name}</h1>
            <span className="set-counts">
              <span className="chip">{plan.type_label}</span>
              {plan.account_name && <span className="chip">{plan.account_name}</span>}
              {plan.status !== 'active' && <span className="chip">{plan.status}</span>}
            </span>
            <span className="push row-actions">
              <button
                className="icon-btn ghost with-icon"
                type="button"
                onClick={() => setEditing(true)}
              >
                <Pencil size={18} /> Edit
              </button>
              <button className="icon-btn ghost with-icon" type="button" onClick={destroy}>
                <Trash size={18} /> Delete
              </button>
            </span>
          </div>

          {plan.notes && <p className="small muted">{plan.notes}</p>}

          {plan.derived.kind === 'rolling' && <RollingSummary plan={plan} />}
          {plan.derived.kind === 'goal' && <GoalSummary plan={plan} />}
          {plan.derived.kind === 'savings' && <SavingsSummary plan={plan} />}
          {plan.derived.kind === 'debt' && <DebtSummary plan={plan} />}
          {plan.derived.kind === 'event' && <EventSummary plan={plan} />}
          {plan.derived.kind === 'scenario' && <ScenarioSummary plan={plan} />}
          {plan.derived.kind === 'affordability' && <AffordabilitySummary plan={plan} />}
          {plan.derived.note && <div className="flash info">{plan.derived.note}</div>}

          {(plan.derived.kind === 'goal' || plan.derived.kind === 'savings') && <FundingActivity plan={plan} />}

          <h2>Window</h2>
          <EventsTable events={plan.events ?? []} />

          <div className="set-head">
            <h2>Your items</h2>
            <button className="push icon-btn ghost" type="button" aria-label="Add item" onClick={() => setItemModal({})}>
              <img src="/static/add.svg?v=2" alt="" className="icon-img icon-img-lg" />
            </button>
          </div>
          <p className="small muted">
            Manual adjustments layered on the projection. Give an item a category and matching amount to track it
            against real transactions.
          </p>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th className="num">Amount</th>
                  <th className="num">Matched</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(plan.items ?? []).map((item) => (
                  <tr key={item.id}>
                    <td>{item.date ?? '—'}</td>
                    <td>{item.description || '—'}</td>
                    <td className="muted">{item.category_path || '—'}</td>
                    <td className="num money">
                      {item.direction === 'out' ? '-' : '+'}
                      {formatMoney(item.amount_cents)}
                    </td>
                    <td className="num muted">{item.matched_date ?? '—'}</td>
                    <td>
                      <span className="icon-group">
                        <button
                          className="icon-btn ghost"
                          type="button"
                          aria-label="Edit item"
                          onClick={() => setItemModal({ item })}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-btn ghost"
                          type="button"
                          aria-label="Delete item"
                          onClick={() => void removeItem(item)}
                        >
                          <Trash size={16} />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
                {(plan.items ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No manual items yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {editing && (
            <PlanFormModal
              plan={plan}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false)
                refresh()
              }}
            />
          )}
          {itemModal && (
            <ItemModal
              plan={plan}
              item={itemModal.item}
              onClose={() => setItemModal(null)}
              onSaved={() => {
                setItemModal(null)
                refresh()
              }}
            />
          )}
        </>
      )}
    </>
  )
}