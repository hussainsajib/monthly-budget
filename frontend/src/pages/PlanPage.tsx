import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Tooltip } from 'react-tooltip'
import { usePlans } from '../queries'
import { formatMoney } from '../money'
import type { Plan } from '../types'
import { PlanFormModal } from '../components/PlanForm'
import { Loading } from '../components/ui'

function headline(plan: Plan): { value: string; note: string } {
  const d = plan.derived
  switch (plan.type) {
    case 'rolling':
      return { value: formatMoney(d.safe_to_spend_cents ?? 0), note: 'safe to spend' }
    case 'goal':
      return { value: `${d.progress_pct ?? 0}%`, note: `of ${formatMoney(d.target_cents ?? 0)}` }
    case 'debt':
      return {
        value: d.months_to_payoff != null ? `${d.months_to_payoff} mo` : '—',
        note: d.months_to_payoff != null ? `paying ${formatMoney(d.monthly_payment_cents ?? 0)}/mo` : 'set a payment',
      }
    case 'event':
      return { value: formatMoney(d.estimate_cents ?? 0), note: `of ${formatMoney(d.budget_cents ?? 0)} budget` }
    case 'scenario':
      return { value: formatMoney(d.net_cents ?? 0), note: 'projected net' }
    case 'affordability':
      return {
        value: formatMoney(d.balance_after_cents ?? 0),
        note: d.affordable ? 'after purchase' : `short ${formatMoney(d.shortfall_cents ?? 0)}`,
      }
    default:
      return { value: formatMoney(d.headline_cents ?? 0), note: 'net' }
  }
}

export default function PlanPage() {
  const plans = usePlans()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  const rows = plans.data ?? []

  return (
    <>
      <div className="set-head">
        <h1>Plan</h1>
        <span className="set-counts">
          <span className="chip">{rows.length} {rows.length === 1 ? 'plan' : 'plans'}</span>
        </span>
        <button
          className="push icon-btn ghost"
          type="button"
          aria-label="New plan"
          data-tooltip-id="plan-tip"
          data-tooltip-content="New plan"
          onClick={() => setCreating(true)}
        >
          <img src="/static/add.svg?v=2" alt="" className="icon-img icon-img-lg" />
        </button>
      </div>

      <p className="small muted">
        Plans are hypothetical projections built from your transactions, recurring items and balances. They never change
        your ledger.
      </p>

      <Loading query={plans} />

      {plans.data && rows.length === 0 && (
        <div className="card">
          <p className="muted">No plans yet. Create one to project the days until your next paychecks or to save toward a goal.</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="tile-grid">
          {rows.map((plan) => {
            const h = headline(plan)
            return (
              <Link key={plan.id} to={`/plan/${plan.id}`} className="tile">
                <span className="tile-head">
                  <span className="tile-name">{plan.name}</span>
                  <span className="chip">{plan.type_label}</span>
                  {plan.status !== 'active' && <span className="chip">{plan.status}</span>}
                </span>
                <span className="tile-value">{h.value}</span>
                <span className="tile-meta">
                  {h.note}
                  {plan.account_name ? ` · ${plan.account_name}` : ''}
                </span>
                {plan.notes && <span className="tile-meta">{plan.notes}</span>}
              </Link>
            )
          })}
        </div>
      )}

      {creating && (
        <PlanFormModal onClose={() => setCreating(false)} onSaved={(id) => navigate(`/plan/${id}`)} />
      )}
      <Tooltip id="plan-tip" />
    </>
  )
}