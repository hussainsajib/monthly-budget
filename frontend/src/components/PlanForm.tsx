import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import Select, { type MultiValue, type StylesConfig } from 'react-select'
import { api } from '../api'
import { centsToInput, formatMoney, todayIso } from '../money'
import { useAccounts, useCategories, useCategoryConfig, usePlanTypes, useRecurring } from '../queries'
import { useRun } from '../toast'
import type { Category, Plan, PlanBody, PlanConfigField, PlanType, Recurring, Schedule } from '../types'
import { AccountSelect, CategorySelect, selectStyles } from './selects'
import { Modal } from './ui'

const NEW_PAYCHECK = '__new__'

type RecurringImportOption = { value: string; label: string }

type PaycheckFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'

interface NewPaycheckDraft {
  description: string
  amount: string
  category_id: number | null
  account_id: number | null
  start: string
  frequency: PaycheckFrequency
}

const emptyPaycheck = (): NewPaycheckDraft => ({
  description: '',
  amount: '',
  category_id: null,
  account_id: null,
  start: todayIso(),
  frequency: 'monthly',
})

function isoWeekday(iso: string): number {
  return (new Date(`${iso}T00:00:00`).getDay() + 6) % 7
}

function paycheckSchedule(frequency: PaycheckFrequency, start: string): Schedule {
  const base = { start, until: null, count: null }
  if (frequency === 'weekly') {
    return { ...base, freq: 'weekly', interval: 1, by_weekday: [isoWeekday(start)] }
  }
  if (frequency === 'biweekly') {
    return { ...base, freq: 'weekly', interval: 2, by_weekday: [isoWeekday(start)] }
  }
  if (frequency === 'semimonthly') {
    return { ...base, freq: 'monthly', interval: 1, by_month_day: [1, 15] }
  }
  return { ...base, freq: 'monthly', interval: 1, by_month_day: [Number(start.slice(8, 10))] }
}

type ConfigValue = string | number[]

function defaultConfig(type: PlanType): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {}
  for (const f of type.config_fields) {
    if (f.kind === 'select') out[f.key] = f.options[0]?.key ?? ''
    else if (f.kind === 'money') out[f.key] = '0'
    else if (f.kind === 'int') out[f.key] = f.placeholder || '0'
    else if (f.kind === 'categories') out[f.key] = []
    else out[f.key] = ''
  }
  return out
}

function configFromPlan(type: PlanType, plan: Plan): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {}
  for (const f of type.config_fields) {
    const raw = plan.config[f.key]
    if (raw == null) out[f.key] = ''
    else if (f.kind === 'money') out[f.key] = centsToInput(Number(raw))
    else if (f.kind === 'categories') out[f.key] = Array.isArray(raw) ? raw.map((x) => Number(x)) : []
    else out[f.key] = String(raw)
  }
  return out
}

function CategoryMultiSelect({
  categories,
  value,
  onChange,
  id,
}: {
  categories: Category[]
  value: number[]
  onChange: (ids: number[]) => void
  id?: string
}) {
  const options = categories
    .filter((c) => !c.has_children && c.is_active)
    .map((c) => ({ value: String(c.id), label: c.path }))
  return (
    <Select
      inputId={id}
      classNamePrefix="rs"
      menuPosition="fixed"
      menuPortalTarget={document.body}
      styles={selectStyles as unknown as StylesConfig<RecurringImportOption, true>}
      isMulti
      isSearchable
      closeMenuOnSelect={false}
      hideSelectedOptions={false}
      options={options}
      value={options.filter((o) => value.includes(Number(o.value)))}
      placeholder="Choose categories…"
      onChange={(vals: MultiValue<RecurringImportOption>) => onChange((vals ?? []).map((o) => Number(o.value)))}
    />
  )
}

function ConfigFieldInput({
  field,
  value,
  onChange,
  categories,
  idPrefix,
}: {
  field: PlanConfigField
  value: ConfigValue
  onChange: (v: ConfigValue) => void
  categories: ReturnType<typeof useCategories>['data']
  idPrefix: string
}) {
  const id = `${idPrefix}-${field.key}`
  if (field.kind === 'categories') {
    return (
      <div className="field-full">
        <label htmlFor={id}>{field.label}</label>
        <CategoryMultiSelect
          id={id}
          categories={categories ?? []}
          value={Array.isArray(value) ? value : []}
          onChange={(ids) => onChange(ids)}
        />
        {field.help && <span className="small muted">{field.help}</span>}
      </div>
    )
  }
  const str = typeof value === 'string' ? value : ''
  if (field.kind === 'category') {
    return (
      <div className="field-full">
        <label htmlFor={id}>{field.label}</label>
        <CategorySelect
          id={id}
          categories={categories ?? []}
          value={str ? Number(str) : null}
          onChange={(v) => onChange(v == null ? '' : String(v))}
          blank={field.help || '— none —'}
        />
      </div>
    )
  }
  return (
    <div>
      <label htmlFor={id}>{field.label}</label>
      {field.kind === 'select' ? (
        <select id={id} value={str} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={field.kind === 'date' ? 'date' : 'text'}
          inputMode={field.kind === 'money' || field.kind === 'int' ? 'decimal' : undefined}
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.help && <span className="small muted">{field.help}</span>}
    </div>
  )
}

function PaycheckField({
  field,
  value,
  onChange,
  templates,
  accounts,
  categories,
  draft,
  onDraftChange,
  idPrefix,
}: {
  field: PlanConfigField
  value: string
  onChange: (v: string) => void
  templates: Recurring[]
  accounts: ReturnType<typeof useAccounts>['data']
  categories: ReturnType<typeof useCategories>['data']
  draft: NewPaycheckDraft
  onDraftChange: (d: NewPaycheckDraft) => void
  idPrefix: string
}) {
  const id = `${idPrefix}-${field.key}`
  const options = [
    { value: '', label: 'Any recurring income' },
    ...templates.map((t) => ({
      value: String(t.id),
      label: `${t.description} · ${formatMoney(t.amount_cents)}${t.is_active ? '' : ' (inactive)'}`,
    })),
    { value: NEW_PAYCHECK, label: 'Create a new paycheck…' },
  ]
  const selected = options.find((o) => o.value === value) ?? options[0]
  const set = <K extends keyof NewPaycheckDraft>(k: K, v: NewPaycheckDraft[K]) =>
    onDraftChange({ ...draft, [k]: v })

  return (
    <div className="field-full">
      <label htmlFor={id}>{field.label}</label>
      <Select
        inputId={id}
        classNamePrefix="rs"
        menuPosition="fixed"
        menuPortalTarget={document.body}
        styles={selectStyles}
        isSearchable
        options={options}
        value={selected}
        onChange={(opt) => onChange(opt?.value ?? '')}
      />
      {field.help && <span className="small muted">{field.help}</span>}
      {value === NEW_PAYCHECK && (
        <div className="paycheck-new">
          <span className="small muted">New recurring income</span>
          <div className="form-grid">
            <div>
              <label htmlFor={`${id}-desc`}>Name</label>
              <input
                id={`${id}-desc`}
                type="text"
                required
                maxLength={200}
                value={draft.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${id}-amount`}>Amount ($)</label>
              <input
                id={`${id}-amount`}
                type="text"
                inputMode="decimal"
                required
                value={draft.amount}
                onChange={(e) => set('amount', e.target.value)}
              />
            </div>
            <div className="field-full category-cascade">
              <CategorySelect
                id={`${id}-cat`}
                categories={categories ?? []}
                value={draft.category_id}
                onChange={(v) => set('category_id', v)}
                cascade
                required
              />
            </div>
            <div>
              <label htmlFor={`${id}-acc`}>Account</label>
              <AccountSelect
                id={`${id}-acc`}
                accounts={accounts ?? []}
                value={draft.account_id}
                onChange={(v) => set('account_id', v)}
              />
            </div>
            <div>
              <label htmlFor={`${id}-freq`}>Pay frequency</label>
              <select
                id={`${id}-freq`}
                value={draft.frequency}
                onChange={(e) => set('frequency', e.target.value as PaycheckFrequency)}
              >
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="semimonthly">Twice a month (1st &amp; 15th)</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-start`}>Next pay date</label>
              <input
                id={`${id}-start`}
                type="date"
                required
                value={draft.start}
                onChange={(e) => set('start', e.target.value)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function PlanFormModal({
  plan,
  onClose,
  onSaved,
}: {
  plan?: Plan
  onClose: () => void
  onSaved: (id: number) => void
}) {
  const run = useRun()
  const types = usePlanTypes().data ?? []
  const accounts = useAccounts().data ?? []
  const categories = useCategories().data
  const recurring = useRecurring().data ?? []
  const categoryConfig = useCategoryConfig().data
  const editing = plan != null

  const incomeKinds = new Set(
    (categoryConfig?.types ?? []).filter((t) => t.direction === 'in').map((t) => t.key),
  )
  const incomeTemplates = recurring.filter((t) => t.is_income)
  const incomeCategories = (categories ?? []).filter((c) => incomeKinds.has(c.kind))

  const [typeKey, setTypeKey] = useState(plan?.type ?? '')
  const [name, setName] = useState(plan?.name ?? '')
  const [accountId, setAccountId] = useState<number | null>(plan?.account_id ?? null)
  const [startDate, setStartDate] = useState(plan?.start_date ?? todayIso())
  const [notes, setNotes] = useState(plan?.notes ?? '')
  const [status, setStatus] = useState(plan?.status ?? 'active')
  const [newPaycheck, setNewPaycheck] = useState<NewPaycheckDraft>(emptyPaycheck)
  const selected = types.find((t) => t.key === typeKey)
  const [config, setConfig] = useState<Record<string, ConfigValue>>(() => {
    if (plan) {
      const t = types.find((x) => x.key === plan.type)
      return t ? configFromPlan(t, plan) : {}
    }
    return {}
  })

  const chooseType = (key: string) => {
    setTypeKey(key)
    const t = types.find((x) => x.key === key)
    setConfig(t ? defaultConfig(t) : {})
    setNewPaycheck(emptyPaycheck())
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!selected) return
    const paycheckField = selected.config_fields.find((f) => f.kind === 'paycheck')
    const creatingPaycheck = paycheckField != null && config[paycheckField.key] === NEW_PAYCHECK

    const result = await run(async () => {
      let finalConfig = { ...config }
      if (creatingPaycheck && paycheckField) {
        if (!newPaycheck.description.trim() || !newPaycheck.amount.trim()) {
          throw new Error('Give the new paycheck a name and amount')
        }
        if (newPaycheck.category_id == null) {
          throw new Error('Choose an income category for the new paycheck')
        }
        const created = await api.createRecurring({
          description: newPaycheck.description.trim(),
          category_id: newPaycheck.category_id,
          account_id: newPaycheck.account_id,
          amount: newPaycheck.amount,
          day_of_month: 1,
          schedule: paycheckSchedule(newPaycheck.frequency, newPaycheck.start),
          is_active: true,
        })
        finalConfig = { ...finalConfig, [paycheckField.key]: String(created.id) }
      }
      const body: PlanBody = {
        name,
        type: selected.key,
        account_id: accountId,
        start_date: startDate || null,
        end_date: plan?.end_date ?? null,
        notes,
        status,
        config: finalConfig,
      }
      return editing ? api.updatePlan(plan.id, body) : api.createPlan(body)
    }, editing ? 'Plan saved' : `Created ${name}`)
    if (result) onSaved(result.id)
  }

  return (
    <Modal title={editing ? `Edit ${plan?.name}` : 'New plan'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div>
            <label htmlFor="plan-name">Name</label>
            <input
              id="plan-name"
              type="text"
              required
              autoFocus
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="plan-type">Type</label>
            <select id="plan-type" value={typeKey} disabled={editing} onChange={(e) => chooseType(e.target.value)}>
              <option value="" disabled>
                Choose a type…
              </option>
              {types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                  {t.implemented ? '' : ' (coming soon)'}
                </option>
              ))}
            </select>
          </div>
          {selected && (
            <div>
              <label htmlFor="plan-account">Target account</label>
              <AccountSelect
                id="plan-account"
                accounts={accounts}
                value={accountId}
                onChange={setAccountId}
                blank="— total / none —"
              />
              <span className="small muted">The balance column follows this account.</span>
            </div>
          )}
          {selected?.key === 'savings' && (
            <div>
              <label htmlFor="plan-start">Start date</label>
              <input id="plan-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <span className="small muted">The plan projects every month from here to the target date.</span>
            </div>
          )}
          {(selected?.config_fields ?? []).map((f) =>
            f.kind === 'paycheck' ? (
              <PaycheckField
                key={f.key}
                field={f}
                value={String(config[f.key] ?? '')}
                onChange={(v) => setConfig((prev) => ({ ...prev, [f.key]: v }))}
                templates={incomeTemplates}
                accounts={accounts}
                categories={incomeCategories}
                draft={newPaycheck}
                onDraftChange={setNewPaycheck}
                idPrefix="plan-cfg"
              />
            ) : (
              <ConfigFieldInput
                key={f.key}
                field={f}
                value={config[f.key] ?? ''}
                onChange={(v) => setConfig((prev) => ({ ...prev, [f.key]: v }))}
                categories={categories}
                idPrefix="plan-cfg"
              />
            ),
          )}
          {editing && (
            <div>
              <label htmlFor="plan-status">Status</label>
              <select id="plan-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
                <option value="done">Done</option>
              </select>
            </div>
          )}
          <div className="field-full">
            <label htmlFor="plan-notes">Notes</label>
            <input id="plan-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        {selected && <p className="small muted">{selected.description}</p>}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="shrink" type="submit">
            {editing ? 'Save' : 'Create plan'}
          </button>
          <button className="secondary shrink with-icon" type="button" onClick={onClose}>
            <X size={16} /> Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}