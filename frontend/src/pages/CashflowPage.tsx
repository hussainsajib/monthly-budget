import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { AccountSelect } from '../components/selects'
import { Loading } from '../components/ui'
import { formatMoney } from '../money'
import { useAccounts } from '../queries'

export default function CashflowPage() {
  const accounts = useAccounts()
  const [accountId, setAccountId] = useState<number | null>(null)
  const flow = useQuery({ queryKey: ['cashflow', accountId], queryFn: () => api.cashflow(accountId) })
  const account = flow.data?.account ?? null
  const ledger = flow.data?.ledger ?? null
  const isLoan = account?.is_loan ?? false
  /** A loan reads as amount owed, the inverse of its signed ledger balance. */
  const display = (cents: number) => (isLoan ? -cents : cents)
  const showBank = !isLoan && (ledger?.rows.some((r) => r.bank_balance_cents != null) ?? false)

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
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">{isLoan ? 'Paid' : 'In'}</th>
                  <th className="num">{isLoan ? 'Charged' : 'Out'}</th>
                  <th className="num">{isLoan ? 'Owed' : 'Balance'}</th>
                  {showBank && <th className="num">Bank</th>}
                </tr>
              </thead>
              <tbody>
                {[...ledger.rows].reverse().map((r) => (
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
                    {showBank && (
                      <td
                        className={`num${r.bank_balance_cents != null && r.bank_balance_cents !== r.balance_cents ? ' over' : ''}`}
                        title={
                          r.bank_balance_cents != null && r.bank_balance_cents !== r.balance_cents
                            ? `Ledger is off by ${formatMoney(r.balance_cents - r.bank_balance_cents)}`
                            : undefined
                        }
                      >
                        {r.bank_balance_cents != null ? formatMoney(r.bank_balance_cents) : ''}
                      </td>
                    )}
                  </tr>
                ))}
                {ledger.rows.length === 0 && (
                  <tr>
                    <td colSpan={showBank ? 6 : 5} className="muted">
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
