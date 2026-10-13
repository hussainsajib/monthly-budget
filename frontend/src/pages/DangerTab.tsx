import { useQuery } from '@tanstack/react-query'
import { Trash } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { Loading } from '../components/ui'
import { useRun } from '../toast'

export default function DangerTab() {
  const run = useRun()
  const query = useQuery({ queryKey: ['txn-count'], queryFn: () => api.transactions({ page: 1 }) })
  const total = query.data?.total
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function clear() {
    setBusy(true)
    const res = await run(
      () => api.clearTransactions(),
      (r) => (r.deleted === 0 ? 'No transactions to delete' : `Deleted ${r.deleted} transaction${r.deleted === 1 ? '' : 's'}`),
    )
    setBusy(false)
    if (res) setConfirming(false)
  }

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
        </div>
      )}
    </>
  )
}
