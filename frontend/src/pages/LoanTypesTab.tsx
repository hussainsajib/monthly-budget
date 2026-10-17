import { Plus, Trash } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { Bar } from '../components/table'
import { useLoanTypes } from '../queries'
import { useRun } from '../toast'

interface TypeDraft {
  key: string
  label: string
  saved: boolean
}

export default function LoanTypesTab() {
  const run = useRun()
  const query = useLoanTypes()
  const [draft, setDraft] = useState<TypeDraft[]>([])
  const [seeded, setSeeded] = useState(false)

  if (query.data && !seeded) {
    setDraft(query.data.types.map((t) => ({ key: t.key, label: t.label, saved: true })))
    setSeeded(true)
  }

  const set = (i: number, patch: Partial<TypeDraft>) =>
    setDraft((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  async function save() {
    const types = draft.map((r) => ({ key: r.key.trim(), label: r.label.trim() }))
    const done = await run(() => api.setLoanTypes(types), 'Loan types saved')
    if (done) setDraft((rows) => rows.map((r) => ({ ...r, saved: true })))
  }

  return (
    <>
      <div className="set-head">
        <h2>Loan types</h2>
        <span className="set-counts">
          <span className="chip">{draft.length} {draft.length === 1 ? 'type' : 'types'}</span>
        </span>
        <button
          className="push icon-btn ghost"
          type="button"
          aria-label="Add loan type"
          data-tooltip-id="settings-tip"
          data-tooltip-content="Add loan type"
          onClick={() => setDraft((rows) => [...rows, { key: '', label: '', saved: false }])}
        >
          <img src="/static/add.svg?v=2" alt="" className="icon-img icon-img-lg" />
        </button>
      </div>

      <p className="small muted">
        The list offered when tagging a loan — mortgage, auto, credit card and so on. Names are yours to edit; the
        underlying key of a type already in use is fixed so existing loans keep pointing at it.
      </p>

      {query.isError && <div className="flash err">{query.error?.message ?? 'Failed to load'}</div>}

      <div className="card table-wrap">
        {query.isPending ? (
          <table aria-busy="true">
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }).map((_, row) => (
                <tr key={row}>
                  <td>
                    <Bar w={140} />
                  </td>
                  <td>
                    <Bar w={180} />
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        ) : draft.length === 0 ? (
          <p className="muted">No loan types yet. Add one — for example a credit card or a car loan.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.map((row, i) => (
                <tr key={row.saved ? row.key : `new-${i}`}>
                  <td>
                    <input
                      type="text"
                      aria-label={`Loan type key ${i + 1}`}
                      value={row.key}
                      disabled={row.saved}
                      maxLength={40}
                      onChange={(e) => set(i, { key: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`Loan type name ${i + 1}`}
                      value={row.label}
                      maxLength={40}
                      onChange={(e) => set(i, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <span className="icon-group">
                      <button
                        type="button"
                        className="icon-btn ghost"
                        aria-label={`Remove ${row.label || row.key || 'loan type'}`}
                        data-tooltip-id="settings-tip"
                        data-tooltip-content="Remove"
                        onClick={() => setDraft((rows) => rows.filter((_, idx) => idx !== i))}
                      >
                        <Trash size={18} />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="total-row">
                <td colSpan={2}>{draft.length} loan types</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      <div className="row">
        <button className="shrink with-icon" type="button" disabled={query.isPending} onClick={() => void save()}>
          <img src="/static/save.svg?v=2" alt="" className="icon-img" /> Save
        </button>
        <button
          className="secondary shrink with-icon"
          type="button"
          onClick={() => setDraft((rows) => [...rows, { key: '', label: '', saved: false }])}
        >
          <Plus size={16} /> Add type
        </button>
      </div>
    </>
  )
}
