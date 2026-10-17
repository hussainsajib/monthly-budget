import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { AccountSelect } from '../components/selects'
import { Loading } from '../components/ui'
import { centsToInput, formatMoney } from '../money'
import { useAccounts } from '../queries'
import { useRun } from '../toast'

export default function CashflowPage() {
  const run = useRun()
  const accounts = useAccounts()
  const [accountId, setAccountId] = useState<number | null>(null)
  const flow = useQuery({ queryKey: ['cashflow', accountId], queryFn: () => api.cashflow(accountId) })
  const account = flow.data?.account ?? null
  const ledger = flow.data?.ledger ?? null
  const isLoan = account?.is_loan ?? false
  /** A loan reads as amount owed, the inverse of its signed ledger balance. */
  const display = (cents: number) => (isLoan ? -cents : cents)

  const [low, setLow] = useState('')
  const [warn, setWarn] = useState('')
  useEffect(() => {
    if (ledger) {
      setLow(centsToInput(ledger.low_threshold_cents))
      setWarn(centsToInput(ledger.warn_threshold_cents))
    }
  }, [ledger?.low_threshold_cents, ledger?.warn_threshold_cents])

  const saveThresholds = (e: FormEvent) => {
    e.preventDefault()
    void run(() => api.setThresholds(low, warn), 'Alert levels saved')
  }

  return (
    <>
      <h1>Cash flow</h1>

      <div className="card row">
        <div>
          <label htmlFor="cf-account">Account</label>
          <AccountSelect
            id="cf-account"
            accounts={(accounts.data ?? []).filter((a) => a.is_active)}
            value={accountId ?? account?.id ?? null}
            onChange={setAccountId}
            blank="Choose account…"
          />
        </div>
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
          <div className="card stat">
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

          {!isLoan && (
            <form className="card row" onSubmit={saveThresholds}>
              <div>
                <label htmlFor="cf-low">Red below ($)</label>
                <input id="cf-low" type="text" inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} />
              </div>
              <div>
                <label htmlFor="cf-warn">Orange below ($)</label>
                <input id="cf-warn" type="text" inputMode="decimal" value={warn} onChange={(e) => setWarn(e.target.value)} />
              </div>
              <button className="secondary shrink" type="submit">
                Save alert levels
              </button>
            </form>
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
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">{isLoan ? 'Paid' : 'In'}</th>
                  <th className="num">{isLoan ? 'Charged' : 'Out'}</th>
                  <th className="num">{isLoan ? 'Owed' : 'Balance'}</th>
                </tr>
              </thead>
              <tbody>
                {ledger.rows.map((r) => (
                  <tr key={r.txn_id} className={`${isLoan ? '' : r.level} ${r.is_planned ? 'planned' : ''}`}>
                    <td>{r.date}</td>
                    <td>
                      <Link to={`/transactions/${r.txn_id}`} state={{ from: '/cashflow' }}>
                        {r.description}
                      </Link>
                    </td>
                    <td className="num">{r.delta_cents > 0 ? formatMoney(r.delta_cents) : ''}</td>
                    <td className="num">{r.delta_cents < 0 ? formatMoney(-r.delta_cents) : ''}</td>
                    <td className="num">
                      <b>{formatMoney(display(r.balance_cents))}</b>
                    </td>
                  </tr>
                ))}
                {ledger.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No transactions on this account since its opening date.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
