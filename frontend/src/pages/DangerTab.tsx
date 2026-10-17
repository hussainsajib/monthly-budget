import { useQuery } from '@tanstack/react-query'
import { Search, Trash } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { Loading } from '../components/ui'
import { useRun, useToast } from '../toast'
import type { LedgerCheck } from '../types'

export default function DangerTab() {
  const run = useRun()
  const { fail } = useToast()
  const query = useQuery({ queryKey: ['txn-count'], queryFn: () => api.transactions({ page: 1 }) })
  const total = query.data?.total
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<LedgerCheck | null>(null)

  async function clear() {
    setBusy(true)
    const res = await run(
      () => api.clearTransactions(),
      (r) => (r.deleted === 0 ? 'No transactions to delete' : `Deleted ${r.deleted} transaction${r.deleted === 1 ? '' : 's'}`),
    )
    setBusy(false)
    if (res) setConfirming(false)
  }

  async function checkLedger() {
    setChecking(true)
    try {
      setCheck(await api.checkLedger())
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setChecking(false)
    }
  }

  const broken = check ? check.issues.reduce((n, issue) => n + issue.count, 0) : 0

  return (
    <>
      <h1>Danger</h1>
      <Loading query={query} />
      {total != null && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Transaction data</h2>
          <p className="small muted">
            Delete the transactions you've entered. Categories, accounts, budgets, recurring items and settings are kept. This
            cannot be undone.
          </p>

          <div className="danger-zone">
            <h2>Clear transactions</h2>
            {confirming ? (
              <div className="confirm-box">
                <p>
                  Delete <b>{total} transaction{total === 1 ? '' : 's'}</b>? This cannot be undone.
                </p>
                <div className="row">
                  <button className="danger shrink with-icon" type="button" onClick={clear} disabled={busy}>
                    <Trash size={16} /> Delete transactions
                  </button>
                  <button className="secondary shrink" type="button" onClick={() => setConfirming(false)} disabled={busy}>
                    Keep them
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="small muted">
                  {total === 0 ? 'Nothing to clear — you have no transactions.' : `You currently have ${total} transaction${total === 1 ? '' : 's'}.`}
                </p>
                <div className="row" style={{ marginTop: 12 }}>
                  <button
                    className="danger shrink with-icon"
                    type="button"
                    onClick={() => setConfirming(true)}
                    disabled={total === 0 || busy}
                  >
                    <Trash size={16} /> Clear transactions
                  </button>
                </div>
              </>
            )}
          </div>

          <div style={{ marginTop: 24 }}>
            <h2 style={{ marginTop: 0 }}>Check data</h2>
            <p className="small muted">
              Balances are worked out from your transactions, so a transfer or reimbursement that came out half-written would
              quietly move money the wrong way. This reads the pairings and reports anything that does not line up.
            </p>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="secondary shrink with-icon" type="button" onClick={checkLedger} disabled={checking}>
                <Search size={16} /> Check data
              </button>
            </div>

            {check &&
              (check.ok ? (
                <div className="flash ok" role="status" style={{ marginTop: 16, marginBottom: 0 }}>
                  Checked {check.scanned.transactions} transaction{check.scanned.transactions === 1 ? '' : 's'} across{' '}
                  {check.scanned.transfers} transfer{check.scanned.transfers === 1 ? '' : 's'} and {check.scanned.reimbursements}{' '}
                  reimbursement{check.scanned.reimbursements === 1 ? '' : 's'} — everything lines up.
                </div>
              ) : (
                <div className="flash err" role="alert" style={{ marginTop: 16, marginBottom: 0 }}>
                  <p style={{ marginTop: 0 }}>
                    {broken} entr{broken === 1 ? 'y needs' : 'ies need'} a look:
                  </p>
                  <ul>
                    {check.issues.map((issue) => (
                      <li key={issue.code}>
                        {issue.message} <span className="muted">({issue.count})</span>
                        {issue.txn_ids.length > 0 && (
                          <div className="small muted">Transaction ids: {issue.txn_ids.join(', ')}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </div>
      )}
    </>
  )
}
