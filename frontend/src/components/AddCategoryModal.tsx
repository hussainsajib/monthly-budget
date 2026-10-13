import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { api } from '../api'
import { CategorySelect } from './selects'
import { Modal } from './ui'
import { useCategoryConfig } from '../queries'
import { useRun } from '../toast'
import type { Category } from '../types'

interface Draft {
  name: string
  parent_id: number | null
  kind: string
  budget: string
}

/**
 * Create a category inline (e.g. from the import-rule dialog). After saving it invalidates the
 * category feeds so the caller's picker immediately shows the new category, then calls ``onCreated``.
 *
 * System categories (transfer / reimbursement) are hidden here as parents.
 */
export function AddCategoryModal({
  categories,
  onClose,
  onCreated,
}: {
  categories: Category[]
  onClose: () => void
  onCreated?: (id: number) => void
}) {
  const run = useRun()
  const queryClient = useQueryClient()
  const types = useCategoryConfig().data?.types ?? []
  const [draft, setDraft] = useState<Draft>({ name: '', parent_id: null, kind: 'expense', budget: '0' })
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const parents = categories.filter((c) => c.kind !== 'transfer' && c.kind !== 'reimbursement')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!draft.name.trim()) return
    const created = await run(
      () => api.createCategory({ name: draft.name.trim(), parent_id: draft.parent_id, kind: draft.kind, budget: draft.budget, description: '' }),
      `Added ${draft.name.trim()}`,
    )
    if (!created) return
    await queryClient.invalidateQueries({ queryKey: ['categories'] })
    await queryClient.invalidateQueries({ queryKey: ['categories', 'with-system'] })
    onCreated?.(created.id)
    onClose()
  }

  return createPortal(
    <Modal title="Add category" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div>
            <label htmlFor="cat-name">Name</label>
            <input
              id="cat-name"
              type="text"
              required
              autoFocus
              maxLength={80}
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="cat-kind">Type (top-level only)</label>
            <select
              id="cat-kind"
              value={draft.kind}
              disabled={draft.parent_id !== null}
              onChange={(e) => set('kind', e.target.value)}
            >
              {types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field-full">
            <CategorySelect
              id="cat-parent"
              mode="parent"
              categories={parents}
              value={draft.parent_id}
              onChange={(id) => set('parent_id', id)}
              blank="— top-level section —"
            />
          </div>
          <div>
            <label htmlFor="cat-budget">Default monthly budget ($)</label>
            <input
              id="cat-budget"
              type="text"
              inputMode="decimal"
              value={draft.budget}
              onChange={(e) => set('budget', e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="shrink" type="submit">
            Add category
          </button>
          <button className="secondary shrink" type="button" onClick={onClose}>
            <X size={16} /> Cancel
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  )
}