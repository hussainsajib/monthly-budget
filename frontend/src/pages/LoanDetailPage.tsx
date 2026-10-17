import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { HandCoins, Pencil, Trash } from 'lucide-react'
import { Tooltip } from 'react-tooltip'
import { api } from '../api'
import { LoanFormModal, LoanPaymentModal } from '../components/LoanForm'
import { Loading, Modal } from '../components/ui'
import { formatMoney } from '../money'
import { useLoan } from '../queries'
import { useRun } from '../toast'
import type { Loan } from '../types'

const payoffPct = (loan: Loan) => Math.max(0, Math.min(100, loan.payoff_pct))

export default function LoanDetailPage() {
  const { id } = useParams()
  const loanId = Number(id)
  const navigate = useNavigate()
  const run = useRun()
  const query = useLoan(loanId)
  const [editing, setEditing] = useState(false)
  const [paying, setPaying] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const loan = query.data

  async function destroy() {
    if (!loan) return
    const done = await run(() => api.deleteLoan(loan.account_id).then(() => true), `Deleted ${loan.name}`)
    if (done) navigate('/loans')
  }

  return (
    <>
      <p className="small muted">
        <Link to="/loans">← Loans</Link>
      </p>
      <Loading query={query} />

      {loan && (
        <>
          <div className="set-head">
            <h1>{loan.name}</h1>
            <span className="set-counts">
              <span className="chip">{loan.loan_type_label}</span>
              {loan.lender && <span className="chip">{loan.lender}</span>}
              {!loan.is_active && <span className="chip">inactive</span>}
            </span>
            <span className="push row-actions">
              <button className="icon-btn ghost with-icon" type="button" onClick={() => setPaying(true)}>
                <HandCoins size={18} /> Record payment
              </button>
              <button className="icon-btn ghost with-icon" type="button" onClick={() => setEditing(true)}>
                <Pencil size={18} /> Edit
              </button>
              <button className="icon-btn ghost with-icon" type="button" onClick={() => setConfirming(true)}>
                <Trash size={18} /> Delete
              </button>
            </span>
          </div>

          <div className="card">
            <div className="stat">
              <div>
                <span className="muted small">Owed</span>
                <b>{formatMoney(loan.owed_cents)}</b>
              </div>
              {loan.residual_cents > 0 && (
                <div>
                  <span className="muted small">Residual / balloon</span>
                  <b>{formatMoney(loan.residual_cents)}</b>
                  <span className="small muted">due at the end</span>
                </div>
              )}
              {loan.residual_cents > 0 && (
                <div>
                  <span className="muted small">To pay down</span>
                  <b>{formatMoney(loan.amortizing_owed_cents)}</b>
                  <span className="small muted">owed minus the residual</span>
                </div>
              )}
              <div>
                <span className="muted small">Original principal</span>
                <b>{formatMoney(loan.original_principal_cents)}</b>
              </div>
              <div>
                <span className="muted small">Paid off</span>
                <b>{formatMoney(loan.principal_paid_cents)}</b>
              </div>
              <div>
                <span className="muted small">Payoff</span>
                <b>{payoffPct(loan)}%</b>
              </div>
            </div>
            <div className="progress" style={{ marginTop: 12 }}>
              <span style={{ width: `${payoffPct(loan)}%` }} />
            </div>
          </div>

          <div className="card stat">
            <div>
              <span className="muted small">Interest rate</span>
              <b>{loan.rate_pct ? `${loan.rate_pct}%` : '—'}</b>
              {loan.is_interest_bearing ? <span className="small muted">interest bearing</span> : null}
            </div>
            <div>
              <span className="muted small">Minimum payment</span>
              <b>{loan.min_payment_cents ? formatMoney(loan.min_payment_cents) : '—'}</b>
            </div>
            <div>
              <span className="muted small">Next due</span>
              <b>{loan.next_due_date ?? (loan.due_day ? `day ${loan.due_day}` : '—')}</b>
            </div>
            {loan.credit_limit_cents > 0 && (
              <div>
                <span className="muted small">Credit limit</span>
                <b>{formatMoney(loan.credit_limit_cents)}</b>
                {loan.utilization_pct != null ? (
                  <span className="small muted">{loan.utilization_pct}% used</span>
                ) : null}
              </div>
            )}
            <div>
              <span className="muted small">Transactions</span>
              <b>{loan.transaction_count}</b>
              {loan.last_activity ? <span className="small muted">last {loan.last_activity}</span> : null}
            </div>
          </div>

          {(loan.reference || loan.notes) && (
            <div className="card">
              {loan.reference && (
                <p className="small">
                  <span className="muted">Reference: </span>
                  {loan.reference}
                </p>
              )}
              {loan.notes && (
                <p className="small">
                  <span className="muted">Notes: </span>
                  {loan.notes}
                </p>
              )}
            </div>
          )}

          <h2>History</h2>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Change</th>
                  <th className="num">Owed after</th>
                </tr>
              </thead>
              <tbody>
                {loan.history.map((h) => (
                  <tr key={h.txn_id} className={h.is_planned ? 'planned' : ''}>
                    <td>{h.date}</td>
                    <td>
                      <Link to={`/transactions/${h.txn_id}`} state={{ from: `/loans/${loan.account_id}` }}>
                        {h.description}
                      </Link>
                    </td>
                    <td className={`num ${h.owed_delta_cents < 0 ? 'under' : h.owed_delta_cents > 0 ? 'over' : ''}`}>
                      {formatMoney(h.owed_delta_cents)}
                    </td>
                    <td className="num">
                      <b>{formatMoney(h.owed_cents)}</b>
                    </td>
                  </tr>
                ))}
                {loan.history.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No transactions on this loan yet. Balances start from its opening amount.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {editing && (
            <LoanFormModal
              loan={loan}
              onClose={() => setEditing(false)}
              onSaved={() => setEditing(false)}
            />
          )}
          {paying && <LoanPaymentModal loan={loan} onClose={() => setPaying(false)} onSaved={() => setPaying(false)} />}
          {confirming && (
            <Modal title={`Delete ${loan.name}`} onClose={() => setConfirming(false)}>
              <div className="confirm-box">
                <p>
                  Delete <b>{loan.name}</b>?
                  {loan.transaction_count > 0
                    ? ` Its ${loan.transaction_count} transaction${loan.transaction_count === 1 ? '' : 's'} stay in your ledger but lose this account.`
                    : ' It has nothing attached, so this cannot be undone.'}
                </p>
                <div className="row">
                  <button className="danger shrink with-icon" type="button" onClick={() => void destroy()}>
                    <Trash size={16} /> Delete
                  </button>
                  <button className="secondary shrink" type="button" onClick={() => setConfirming(false)}>
                    Keep it
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </>
      )}
      <Tooltip id="loans-tip" />
    </>
  )
}
