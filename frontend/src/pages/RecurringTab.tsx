import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table'
import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Pencil, Trash2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import Select, { type MultiValue, type StylesConfig } from 'react-select'
import { api } from '../api'
import { AccountSelect, CategorySelect, selectStyles } from '../components/selects'
import { Bar, SortHeader } from '../components/table'
import { Modal, ViewToggle, useViewMode } from '../components/ui'
import { centsToInput, formatMoney, todayIso } from '../money'
import { useAccounts, useCategories, useSortedRecurring } from '../queries'
import { useRun } from '../toast'
import type { Recurring, RecurringBody, Schedule } from '../types'

interface Draft {
  description: string
  category_id: number | null
  account_id: number | null
  amount: string
  schedule: Schedule
  is_active: boolean
}

const EMPTY: Draft = {
  description: '',
  category_id: null,
  account_id: null,
  amount: '',
  schedule: { freq: 'monthly', interval: 1, start: todayIso(), until: null, count: null, by_month_day: [1] },
  is_active: true,
}

const fromTemplate = (t: Recurring): Draft => ({
  description: t.description,
  category_id: t.category_id,
  account_id: t.account_id,
  amount: centsToInput(t.amount_cents),
  schedule: t.schedule ?? {
    freq: 'monthly',
    interval: 1,
    start: todayIso(),
    until: null,
    count: null,
    by_month_day: [t.day_of_month],
  },
  is_active: t.is_active,
})

const toBody = (d: Draft): RecurringBody => ({
  description: d.description,
  category_id: d.category_id as number,
  account_id: d.account_id,
  amount: d.amount,
  day_of_month: 1,
  schedule: d.schedule,
  is_active: d.is_active,
})

function templateBody(t: Recurring, patch: Partial<RecurringBody> = {}): RecurringBody {
  return {
    description: t.description,
    category_id: t.category_id,
    account_id: t.account_id,
    amount: centsToInput(t.amount_cents),
    day_of_month: 1,
    schedule: t.schedule ?? {
      freq: 'monthly',
      interval: 1,
      start: todayIso(),
      until: null,
      count: null,
      by_month_day: [t.day_of_month],
    },
    is_active: t.is_active,
    ...patch,
  }
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function isoWeekday(iso: string): number {
  return (new Date(`${iso}T00:00:00`).getDay() + 6) % 7 // 0=Mon..6=Sun
}

function defaultSchedule(freq: Schedule['freq']): Schedule {
  const start = todayIso()
  const base: Schedule = { freq, interval: 1, start, until: null, count: null }
  if (freq === 'weekly') return { ...base, by_weekday: [isoWeekday(start)] }
  if (freq === 'monthly') return { ...base, by_month_day: [1] }
  if (freq === 'yearly') {
    const [, month, day] = start.split('-').map(Number)
    return { ...base, month, day }
  }
  return base
}

const DAY_OPTIONS = [
  ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
  { value: 'last', label: 'Last day' },
]
type DayOption = { value: string; label: string }

function nthLabel(week: number): string {
  if (week === -1) return 'last'
  const suffix = week === 1 ? 'st' : week === 2 ? 'nd' : week === 3 ? 'rd' : 'th'
  return `${week}${suffix}`
}

function scheduleSummary(s: Schedule): string {
  const parts: string[] = []
  if (s.freq === 'daily') {
    parts.push(`Every ${plural(s.interval, 'day')}`)
  } else if (s.freq === 'weekly') {
    const days = s.by_weekday?.length ? s.by_weekday.map((i) => WEEKDAYS[i]).join(', ') : WEEKDAYS[isoWeekday(s.start)]
    parts.push(`Every ${plural(s.interval, 'week')} on ${days}`)
  } else if (s.freq === 'monthly') {
    if (s.by_nth_weekday) {
      parts.push(`${nthLabel(s.by_nth_weekday.week)} ${WEEKDAYS[s.by_nth_weekday.weekday]} every ${plural(s.interval, 'month')}`)
    } else {
      const days = s.by_month_day?.map((d) => (d === -1 ? 'last day' : String(d))).join(', ') ?? '1'
      parts.push(`Monthly on ${days}`)
    }
  } else {
    const mon = MONTHS[(s.month ?? 1) - 1]
    if (s.by_nth_weekday) parts.push(`Yearly in ${mon}, ${nthLabel(s.by_nth_weekday.week)} ${WEEKDAYS[s.by_nth_weekday.weekday]}`)
    else parts.push(`Yearly in ${mon} on ${s.day === -1 ? 'last day' : s.day ?? 1}`)
  }
  if (s.until) parts.push(`until ${s.until}`)
  if (s.count != null) parts.push(`${s.count} total`)
  return parts.join(' Â· ')
}

function SimpleSelect({
  id,
  options,
  value,
  onChange,
  placeholder,
}: {
  id?: string
  options: DayOption[]
  value: string | null
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <Select
      inputId={id}
      classNamePrefix="rs"
      menuPosition="fixed"
      menuPortalTarget={document.body}
      styles={selectStyles}
      isSearchable
      options={options}
      value={options.find((o) => o.value === value) ?? null}
      placeholder={placeholder}
      onChange={(opt) => {
        if (opt) onChange(opt.value)
      }}
    />
  )
}

function RecurrenceEditor({ schedule, onChange }: { schedule: Schedule; onChange: (s: Schedule) => void }) {
  const set = (patch: Partial<Schedule>) => onChange({ ...schedule, ...patch } as Schedule)

  const monthlyMode = schedule.by_nth_weekday ? 'nth' : 'days'
  const yearlyMode = schedule.by_nth_weekday ? 'nth' : 'days'
  const ends: 'never' | 'until' | 'count' = schedule.until ? 'until' : schedule.count != null ? 'count' : 'never'

  const freqLabel = plural(schedule.interval, { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[schedule.freq])

  return (
    <>
      <div>
        <label htmlFor="rec-repeat">Repeat</label>
        <SimpleSelect
          id="rec-repeat"
          options={[
            { value: 'daily', label: 'Daily' },
            { value: 'weekly', label: 'Weekly' },
            { value: 'monthly', label: 'Monthly' },
            { value: 'yearly', label: 'Yearly' },
          ]}
          value={schedule.freq}
          onChange={(v) => onChange(defaultSchedule(v as Schedule['freq']))}
        />
      </div>
      <div>
        <label htmlFor="rec-interval">Every</label>
        <div className="inline-field">
          <input
            id="rec-interval"
            type="number"
            min={1}
            value={schedule.interval}
            onChange={(e) => set({ interval: Number(e.target.value) || 1 })}
          />
          <span className="unit-label">{freqLabel}</span>
        </div>
      </div>

      {schedule.freq === 'weekly' && (
        <div className="field-full">
          <label id="rec-on">On</label>
          <div className="day-toggles" role="group" aria-labelledby="rec-on">
            {WEEKDAYS.map((name, i) => {
              const on = schedule.by_weekday?.includes(i) ?? false
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={on}
                  className={`secondary${on ? ' on' : ''}`}
                  onClick={() => {
                    const next = schedule.by_weekday?.includes(i)
                      ? schedule.by_weekday.filter((d) => d !== i)
                      : [...(schedule.by_weekday ?? []), i]
                    set({ by_weekday: next.length ? next : undefined })
                  }}
                >
                  {name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {schedule.freq === 'monthly' && (
        <>
          {monthlyMode === 'days' ? (
            <div>
              <label>Days</label>
              <Select
                classNamePrefix="rs"
                menuPosition="fixed"
                menuPortalTarget={document.body}
                styles={selectStyles as unknown as StylesConfig<DayOption, true>}
                isMulti
                isSearchable
                options={DAY_OPTIONS}
                value={(schedule.by_month_day ?? [1]).map((d) => ({ value: String(d), label: d === -1 ? 'Last day' : String(d) }))}
                placeholder="Pick daysâ€¦"
                onChange={(vals: MultiValue<DayOption>) =>
                  set({ by_month_day: (vals ?? []).map((o) => (o.value === 'last' ? -1 : Number(o.value))) })
                }
              />
            </div>
          ) : (
            <NthWeekdayFields
              nth={schedule.by_nth_weekday ?? { week: 1, weekday: 0 }}
              onChange={(by_nth_weekday) => set({ by_nth_weekday })}
            />
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={monthlyMode === 'nth'}
              onChange={(e) =>
                set(
                  e.target.checked
                    ? { by_nth_weekday: { week: 1, weekday: isoWeekday(schedule.start) }, by_month_day: undefined }
                    : { by_month_day: [1], by_nth_weekday: undefined },
                )
              }
            />On the Nth weekday
          </label>
        </>
      )}

      {schedule.freq === 'yearly' && (
        <>
          <div>
            <label htmlFor="rec-month">Month</label>
            <SimpleSelect
              id="rec-month"
              options={MONTHS.map((name, i) => ({ value: String(i + 1), label: name }))}
              value={String(schedule.month ?? 1)}
              onChange={(v) => set({ month: Number(v) })}
            />
          </div>
          {yearlyMode === 'days' ? (
            <div>
              <label>Day</label>
              <Select
                classNamePrefix="rs"
                menuPosition="fixed"
                menuPortalTarget={document.body}
                styles={selectStyles}
                isSearchable
                options={DAY_OPTIONS}
                value={DAY_OPTIONS.find((o) => o.value === (schedule.day === -1 ? 'last' : String(schedule.day ?? 1))) ?? null}
                placeholder="Day"
                onChange={(opt) => set({ day: opt ? (opt.value === 'last' ? -1 : Number(opt.value)) : (schedule.day ?? 1) })}
              />
            </div>
          ) : (
            <NthWeekdayFields
              nth={schedule.by_nth_weekday ?? { week: 1, weekday: 0 }}
              onChange={(by_nth_weekday) => set({ by_nth_weekday, day: undefined })}
            />
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={yearlyMode === 'nth'}
              onChange={(e) =>
                set(
                  e.target.checked
                    ? { by_nth_weekday: { week: 1, weekday: 0 }, day: undefined }
                    : { day: schedule.day ?? 1, by_nth_weekday: undefined },
                )
              }
            />Nth weekday
          </label>
        </>
      )}

      <div>
        <label htmlFor="rec-start">Starts on</label>
        <input id="rec-start" type="date" value={schedule.start} onChange={(e) => set({ start: e.target.value })} />
      </div>

      <div>
        <label htmlFor="rec-ends">Ends</label>
        <SimpleSelect
          id="rec-ends"
          options={[
            { value: 'never', label: 'Never' },
            { value: 'until', label: 'On date' },
            { value: 'count', label: 'After N occurrences' },
          ]}
          value={ends}
          onChange={(v) => {
            if (v === 'until') set({ until: todayIso(), count: null })
            else if (v === 'count') set({ count: 30, until: null })
            else set({ until: null, count: null })
          }}
        />
      </div>
      {ends === 'until' && (
        <div>
          <label htmlFor="rec-until">End date</label>
          <input id="rec-until" type="date" value={schedule.until ?? ''} onChange={(e) => set({ until: e.target.value })} />
        </div>
      )}
      {ends === 'count' && (
        <div>
          <label htmlFor="rec-count">Occurrences</label>
          <input
            id="rec-count"
            type="number"
            min={1}
            value={schedule.count ?? 30}
            onChange={(e) => set({ count: Number(e.target.value) || 1 })}
          />
        </div>
      )}
    </>
  )
}

function NthWeekdayFields({
  nth,
  onChange,
}: {
  nth: { week: number; weekday: number }
  onChange: (n: { week: number; weekday: number }) => void
}) {
  return (
    <>
      <div>
        <label htmlFor="rec-week">Week</label>
        <SimpleSelect
          id="rec-week"
          options={[
            ...[1, 2, 3, 4, 5].map((w) => ({
              value: String(w),
              label: `${w}${w === 1 ? 'st' : w === 2 ? 'nd' : w === 3 ? 'rd' : 'th'}`,
            })),
            { value: '-1', label: 'Last' },
          ]}
          value={String(nth.week)}
          onChange={(v) => onChange({ ...nth, week: Number(v) })}
        />
      </div>
      <div>
        <label htmlFor="rec-weekday">Weekday</label>
        <SimpleSelect
          id="rec-weekday"
          options={WEEKDAYS.map((name, i) => ({ value: String(i), label: name }))}
          value={String(nth.weekday)}
          onChange={(v) => onChange({ ...nth, weekday: Number(v) })}
        />
      </div>
    </>
  )
}

function BasicFields({ draft, onChange, idPrefix }: { draft: Draft; onChange: (d: Draft) => void; idPrefix: string }) {
  const categories = useCategories()
  const accounts = useAccounts()
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v })
  return (
    <>
      <div className="field-full">
        <label htmlFor={`${idPrefix}-desc`}>Description</label>
        <input
          id={`${idPrefix}-desc`}
          type="text"
          required
          autoFocus
          value={draft.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </div>
      <div className="field-full category-cascade">
        <CategorySelect
          id={`${idPrefix}-cat`}
          categories={categories.data ?? []}
          value={draft.category_id}
          onChange={(id) => set('category_id', id)}
          cascade
          required
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-acc`}>Account</label>
        <AccountSelect
          id={`${idPrefix}-acc`}
          accounts={accounts.data ?? []}
          value={draft.account_id}
          onChange={(id) => set('account_id', id)}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-amt`}>Amount ($)</label>
        <input
          id={`${idPrefix}-amt`}
          type="text"
          inputMode="decimal"
          required
          value={draft.amount}
          onChange={(e) => set('amount', e.target.value)}
        />
      </div>
    </>
  )
}

function RecurrenceWizard({
  title,
  initial,
  submitLabel,
  submitIcon,
  onSubmit,
  onClose,
  danger,
}: {
  title: string
  initial: Draft
  submitLabel: string
  submitIcon: 'add' | 'save'
  onSubmit: (d: Draft) => void
  onClose: () => void
  danger?: ReactNode
}) {
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState(initial)
  const categories = useCategories()
  const accounts = useAccounts()
  const steps = ['Details', 'Recurrence', 'Review']
  const basicDone = draft.description.trim() !== '' && draft.category_id !== null && draft.amount.trim() !== ''
  const categoryPath = categories.data?.find((c) => c.id === draft.category_id)?.path
  const accountName = accounts.data?.find((a) => a.id === draft.account_id)?.name
  const submitSrc = submitIcon === 'add' ? '/static/add.svg?v=2' : '/static/save.svg?v=2'

  function submit() {
    if (draft.category_id === null) return
    onSubmit(draft)
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (step < 2) setStep((s) => s + 1)
          else submit()
        }}
      >
        <div className="wizard-steps">
          {steps.map((s, i) => (
            <span key={s} className={`${i === step ? 'active' : i < step ? 'done' : ''}`}>
              {i + 1}. {s}
            </span>
          ))}
        </div>

        {step === 0 && (
          <div className="form-grid">
            <BasicFields draft={draft} onChange={setDraft} idPrefix="rec-wizard" />
          </div>
        )}

        {step === 1 && (
          <div className="form-grid schedule-grid">
            <RecurrenceEditor schedule={draft.schedule} onChange={(s) => setDraft((d) => ({ ...d, schedule: s }))} />
          </div>
        )}

        {step === 2 && (
          <div className="review-list">
            <div className="review-row">
              <span className="review-label">Description</span>
              <span>{draft.description}</span>
            </div>
            <div className="review-row">
              <span className="review-label">Amount</span>
              <span className="money">{draft.amount}</span>
            </div>
            <div className="review-row">
              <span className="review-label">Category</span>
              <span>{categoryPath ?? 'â€”'}</span>
            </div>
            <div className="review-row">
              <span className="review-label">Account</span>
              <span>{accountName ?? 'â€” none â€”'}</span>
            </div>
            <div className="review-row">
              <span className="review-label">Repeats</span>
              <span>{scheduleSummary(draft.schedule)}</span>
            </div>
            <div className="review-row">
              <span className="review-label">Active</span>
              <label className="check">
                <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft((d) => ({ ...d, is_active: e.target.checked }))} />{draft.is_active ? 'Yes' : 'No'}
              </label>
            </div>
          </div>
        )}

        <div className="row center mt-12">
          {step > 0 && (
            <button className="secondary shrink with-icon" type="button" onClick={() => setStep((s) => s - 1)}>
              <ChevronLeft size={16} /> Back
            </button>
          )}
          <span className="muted shrink push">
            Step {step + 1} of {steps.length}
          </span>
          {step < 2 ? (
            <button className="shrink with-icon" type="submit" disabled={step === 0 && !basicDone}>
              Next <ChevronRight size={16} />
            </button>
          ) : (
            <button className="shrink with-icon" type="submit">
              <img src={submitSrc} alt="" className="icon-img" />{submitLabel}
            </button>
          )}
          <button className="secondary shrink with-icon" type="button" onClick={onClose}>
            <X size={16} /> Cancel
          </button>
        </div>
        {danger}
      </form>
    </Modal>
  )
}

function RecurringSkeleton() {
  const columns: Array<[number, string]> = [
    [180, ''],
    [150, ''],
    [110, 'hide-sm'],
    [96, 'num'],
    [190, ''],
  ]
  return (
    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th>Category</th>
          <th className="hide-sm">Account</th>
          <th className="num">Amount</th>
          <th>Repeats</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: 6 }).map((_, row) => (
          <tr key={row}>
            {columns.map(([w, cls], col) => (
              <td key={col} className={cls}>
                <Bar w={w} />
              </td>
            ))}
            <td />
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RecurringTile({
  template,
  onEdit,
  onToggle,
}: {
  template: Recurring
  onEdit: (t: Recurring) => void
  onToggle: (t: Recurring) => void
}) {
  return (
    <article className="tile">
      <div className="tile-head">
        <span className="tile-name" title={template.description}>
          {template.description}
        </span>
        {!template.is_active && <span className="chip">inactive</span>}
      </div>
      <div className="tile-value">{formatMoney(template.amount_cents)}</div>
      <div className="tile-meta" title={template.category_path}>
        {template.category_path.split(' \u203a ').pop()}
      </div>
      <div className="tile-foot">
        <span className="chip">{scheduleSummary(template.schedule ?? fromTemplate(template).schedule)}</span>
        <span className="icon-group">
          <button
            type="button"
            className="icon-btn ghost"
            aria-label={template.is_active ? `Archive ${template.description}` : `Restore ${template.description}`}
            data-tooltip-id="settings-tip"
            data-tooltip-content={template.is_active ? 'Archive' : 'Restore'}
            onClick={() => onToggle(template)}
          >
            {template.is_active ? <Archive size={18} /> : <ArchiveRestore size={18} />}
          </button>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label={`Edit ${template.description}`}
            data-tooltip-id="settings-tip"
            data-tooltip-content="Edit"
            onClick={() => onEdit(template)}
          >
            <Pencil size={18} />
          </button>
        </span>
      </div>
    </article>
  )
}

function RecurringTilesSkeleton() {
  return (
    <div className="tile-grid" aria-busy="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div className="tile" key={i}>
          <Bar w={140} />
          <Bar w={80} h={20} />
          <Bar w={160} />
        </div>
      ))}
    </div>
  )
}

export default function RecurringTab() {
  const run = useRun()
  const { view, change: setView } = useViewMode('recurring')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'description', desc: false }])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<{ id: number; draft: Draft } | null>(null)
  const [confirming, setConfirming] = useState(false)

  const sort = sorting[0]?.id ?? 'description'
  const dir = sorting[0]?.desc === false ? 'asc' : 'desc'
  const query = useSortedRecurring(sort, dir)
  const templates = query.data ?? []

  const editingTemplate = editing ? templates.find((t) => t.id === editing.id) : undefined
  const inactive = templates.filter((t) => !t.is_active).length

  function closeModal() {
    setAdding(false)
    setEditing(null)
    setConfirming(false)
  }

  function openAdd() {
    setEditing(null)
    setConfirming(false)
    setAdding(true)
  }

  function openEdit(t: Recurring) {
    setAdding(false)
    setConfirming(false)
    setEditing({ id: t.id, draft: fromTemplate(t) })
  }

  async function createRecurring(d: Draft) {
    if (d.category_id === null) return
    if (await run(() => api.createRecurring(toBody(d)), `Added ${d.description.trim()}`)) closeModal()
  }

  async function updateRecurringDraft(id: number, d: Draft) {
    if (d.category_id === null) return
    if (await run(() => api.updateRecurring(id, toBody(d)), 'Saved')) closeModal()
  }

  const toggleActive = (t: Recurring) =>
    void run(
      () => api.updateRecurring(t.id, templateBody(t, { is_active: !t.is_active })),
      t.is_active ? `Archived ${t.description}` : `Restored ${t.description}`,
    )

  async function archive() {
    if (!editing || !editingTemplate) return
    const next = { ...editing.draft, is_active: false }
    if (await run(() => api.updateRecurring(editingTemplate.id, toBody(next)), `Archived ${editing.draft.description}`))
      closeModal()
  }

  async function destroy() {
    if (!editingTemplate) return
    if (
      await run(() => api.deleteRecurring(editingTemplate.id).then(() => true), `Deleted ${editingTemplate.description}`)
    )
      closeModal()
  }

  const columns: ColumnDef<Recurring>[] = [
    {
      id: 'description',
      accessorKey: 'description',
      header: ({ column }) => <SortHeader column={column} label="Description" />,
      cell: ({ row }) => {
        const t = row.original
        return (
          <span className="row-label">
            <span className="nm">{t.description}</span>
            {!t.is_active && <span className="chip">inactive</span>}
          </span>
        )
      },
    },
    {
      id: 'category',
      accessorKey: 'category_path',
      header: ({ column }) => <SortHeader column={column} label="Category" />,
      cell: ({ row }) => row.original.category_path.split(' \u203a ').pop(),
    },
    {
      id: 'account',
      accessorKey: 'account_name',
      header: ({ column }) => <SortHeader column={column} label="Account" />,
      cell: ({ row }) => row.original.account_name ?? <span className="empty-cell">â€”</span>,
    },
    {
      id: 'amount',
      accessorKey: 'amount_cents',
      header: ({ column }) => <SortHeader column={column} label="Amount" />,
      cell: ({ row }) => <b>{formatMoney(row.original.amount_cents)}</b>,
    },
    {
      id: 'schedule',
      enableSorting: false,
      header: () => 'Repeats',
      cell: ({ row }) => scheduleSummary(row.original.schedule ?? fromTemplate(row.original).schedule),
    },
    {
      id: 'actions',
      enableSorting: false,
      header: () => null,
      cell: ({ row }) => {
        const t = row.original
        return (
          <span className="icon-group">
            <button
              type="button"
              className="icon-btn ghost"
              aria-label={t.is_active ? `Archive ${t.description}` : `Restore ${t.description}`}
              data-tooltip-id="settings-tip"
              data-tooltip-content={t.is_active ? 'Archive' : 'Restore'}
              onClick={() => toggleActive(t)}
            >
              {t.is_active ? <Archive size={18} /> : <ArchiveRestore size={18} />}
            </button>
            <button
              type="button"
              className="icon-btn ghost"
              aria-label={`Edit ${t.description}`}
              data-tooltip-id="settings-tip"
              data-tooltip-content="Edit"
              onClick={() => openEdit(t)}
            >
              <Pencil size={18} />
            </button>
          </span>
        )
      },
    },
  ]

  const table = useReactTable({
    data: templates,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
  })

  const cellClass = (id: string) => (id === 'account' ? 'hide-sm' : id === 'amount' ? 'num' : '')

  return (
    <>
      <div className="set-head">
        <h2>Recurring items</h2>
        <span className="set-counts">
          <span className="chip">{plural(templates.length, 'item')}</span>
          {inactive > 0 && <span className="chip">{inactive} inactive</span>}
        </span>
        <ViewToggle view={view} onChange={setView} />
        <button
          className="push icon-btn ghost"
          type="button"
          aria-label="Add recurring item"
          data-tooltip-id="settings-tip"
          data-tooltip-content="Add recurring item"
          onClick={openAdd}
        >
          <img src="/static/add.svg?v=2" alt="" className="icon-img icon-img-lg" />
        </button>
      </div>

      {adding && (
        <RecurrenceWizard
          title="Add recurring item"
          initial={EMPTY}
          submitLabel="Add"
          submitIcon="add"
          onSubmit={createRecurring}
          onClose={closeModal}
        />
      )}

      {editing && (
        <RecurrenceWizard
          title={`Edit ${editing.draft.description}`}
          initial={editing.draft}
          submitLabel="Save"
          submitIcon="save"
          onSubmit={(d) => updateRecurringDraft(editing.id, d)}
          onClose={closeModal}
          danger={
            editingTemplate && (
              <div className="danger-zone">
                <h2>Delete</h2>
                {confirming ? (
                  <div className="confirm-box">
                    <p>
                      Delete <b>{editingTemplate.description}</b>? Any transactions it already created stay in your
                      ledger â€” only the rule is removed.
                    </p>
                    <div className="row">
                      <button className="danger shrink with-icon" type="button" onClick={() => void destroy()}>
                        <Trash2 size={16} /> Delete
                      </button>
                      <button className="secondary shrink" type="button" onClick={() => setConfirming(false)}>
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="small muted">
                      Removing the rule leaves any transactions it already created in your ledger.
                    </p>
                    <div className="row" style={{ marginTop: 12 }}>
                      <button className="secondary shrink with-icon" type="button" onClick={() => void archive()}>
                        <Archive size={16} /> Archive instead
                      </button>
                      <button className="danger shrink with-icon" type="button" onClick={() => setConfirming(true)}>
                        <Trash2 size={16} /> Delete item
                      </button>
                    </div>
                  </>
                )}
              </div>
            )
          }
        />
      )}

      {query.isError && <div className="flash err">{query.error?.message ?? 'Failed to load'}</div>}

      {query.isPending ? (
        view === 'card' ? (
          <RecurringTilesSkeleton />
        ) : (
          <div className="card table-wrap">
            <RecurringSkeleton />
          </div>
        )
      ) : templates.length === 0 ? (
        <div className="card">
          <p className="muted">No recurring items yet. Add one to create its transactions automatically each period.</p>
        </div>
      ) : view === 'card' ? (
        <div className="tile-grid">
          {templates.map((t) => (
            <RecurringTile key={t.id} template={t} onEdit={openEdit} onToggle={toggleActive} />
          ))}
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th key={header.id} className={cellClass(header.column.id)}>
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className={cellClass(cell.column.id)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
