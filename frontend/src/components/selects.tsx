import { useEffect, useState, type ReactNode } from 'react'
import Select, { type StylesConfig } from 'react-select'
import { levelsOf } from '../categoryConfig'
import { useCategoryConfig } from '../queries'
import type { Account, Category } from '../types'

/** Deepest level a category can have a child under (server MAX_DEPTH is 4 levels: depth 0..3). */
const MAX_PARENT_DEPTH = 2

/** Must match the separator the server builds category paths with (app/services/categories.py). */
const PATH_SEP = ' \u203a '

type Option = { value: string; label: string }

/** Shared react-select theme: matches the app's inputs and follows the light/dark CSS variables. */
export const selectStyles: StylesConfig<Option, false> = {
  container: (base, state) => (state.isDisabled ? { ...base, pointerEvents: 'auto' } : base),
  control: (base, state) => ({
    ...base,
    minHeight: 44,
    backgroundColor: 'var(--bg)',
    borderColor: state.isFocused ? 'var(--accent)' : 'var(--line)',
    boxShadow: state.isFocused ? '0 0 0 1px var(--accent)' : 'none',
    borderRadius: 8,
    flexWrap: 'nowrap',
    cursor: state.isDisabled ? 'not-allowed' : 'default',
    opacity: state.isDisabled ? 0.5 : 1,
    ':hover': { borderColor: state.isFocused ? 'var(--accent)' : 'var(--line)' },
  }),
  menu: (base) => ({
    ...base,
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    marginTop: 4,
    marginBottom: 4,
    zIndex: 30,
  }),
  menuPortal: (base) => ({ ...base, zIndex: 200 }),
  menuList: (base) => ({ ...base, backgroundColor: 'var(--surface)', padding: 4 }),
  option: (base, state) => ({
    ...base,
    backgroundColor: state.isSelected ? 'var(--accent)' : state.isFocused ? 'var(--bg)' : 'var(--surface)',
    color: state.isSelected ? 'var(--accent-ink)' : 'var(--ink)',
    cursor: 'pointer',
  }),
  valueContainer: (base) => ({ ...base, minWidth: 0, overflow: 'hidden' }),
  singleValue: (base, state) => ({
    ...base,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: state.isDisabled ? 'var(--muted)' : 'var(--ink)',
  }),
  input: (base) => ({ ...base, color: 'var(--ink)' }),
  placeholder: (base) => ({ ...base, color: 'var(--muted)' }),
  indicatorSeparator: (base) => ({ ...base, backgroundColor: 'var(--line)' }),
  dropdownIndicator: (base) => ({ ...base, color: 'var(--muted)' }),
  clearIndicator: (base) => ({ ...base, color: 'var(--muted)' }),
  noOptionsMessage: (base) => ({ ...base, color: 'var(--muted)' }),
  multiValue: (base) => ({ ...base, backgroundColor: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 6 }),
  multiValueLabel: (base) => ({ ...base, color: 'var(--ink)' }),
  multiValueRemove: (base) => ({ ...base, color: 'var(--muted)', ':hover': { backgroundColor: 'transparent', color: 'var(--bad)' } }),
}

function rootOf(categories: Category[], id: number | null): number | null {
  if (id == null) return null
  const byId = new Map(categories.map((c) => [c.id, c]))
  let cur = byId.get(id)
  if (!cur) return null
  while (cur.parent_id != null) {
    const parent = byId.get(cur.parent_id)
    if (!parent) break
    cur = parent
  }
  return cur.id
}

function isUnder(categories: Category[], c: Category, rootId: number): boolean {
  const byId = new Map(categories.map((x) => [x.id, x]))
  let cur: Category | undefined = c
  while (cur && cur.parent_id != null) {
    if (cur.parent_id === rootId) return true
    cur = byId.get(cur.parent_id)
  }
  return false
}

function labelOf(c: Category, relativeTo?: Category): string {
  const name = relativeTo ? c.path.slice(relativeTo.path.length + PATH_SEP.length) : c.name
  return c.is_active ? name : `${name} (inactive)`
}

/** One column of a cascading pair: optional visible label above its select. */
function PairCol({ htmlFor, label, children }: { htmlFor?: string; label?: string; children: ReactNode }) {
  return (
    <span className="cat-col">
      {label ? <label htmlFor={htmlFor}>{label}</label> : null}
      {children}
    </span>
  )
}

interface CategorySelectProps {
  categories: Category[]
  value: number | null
  onChange: (id: number | null) => void
  /** assignable: leaves a transaction may go under; parent: any node that can take a child. */
  mode?: 'assignable' | 'parent'
  /** Blank label for the sub-category picker (assignable) or the top-level picker (parent). */
  blank?: string
  required?: boolean
  exclude?: Set<number>
  id?: string
  /** Set false in dense contexts (table cells) where the column headers would be noise. */
  showLabels?: boolean
  /** Render one cascading select per configured level instead of the two-column (section + all-descendants) pair. */
  cascade?: boolean
}

export function CategorySelect({
  categories,
  value,
  onChange,
  mode = 'assignable',
  blank = 'Choose…',
  exclude,
  id,
  showLabels = true,
  cascade = false,
  required = false,
}: CategorySelectProps) {
  const parentMode = mode === 'parent'
  const levels = levelsOf(useCategoryConfig().data)
  const byId = new Map(categories.map((c) => [c.id, c]))
  const chainOf = (raw: number | null): (number | null)[] => {
    const chain = levels.map(() => null as number | null)
    if (raw == null) return chain
    let cur: Category | undefined = byId.get(raw)
    while (cur && cur.depth < chain.length) {
      chain[cur.depth] = cur.id
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined
    }
    return chain
  }
  const [chain, setChain] = useState<(number | null)[]>(() => chainOf(value))
  const [sectionId, setSectionId] = useState<number | null>(() => rootOf(categories, value))
  const sections = categories.filter((c) => c.depth === 0)

  useEffect(() => {
    setChain(chainOf(value))
  }, [categories, value])

  // Keep the category dropdown in sync when the value is set from outside (edit, autofill).
  // A null value means "nothing chosen yet", so it must not reset a section the user picked.
  useEffect(() => {
    if (value != null) setSectionId(rootOf(categories, value))
  }, [categories, value])

  const section = sectionId != null ? categories.find((c) => c.id === sectionId) : undefined

  const sectionOptions: Option[] = sections
    .filter((c) => c.id === sectionId || c.id === value || ((c.is_active || c.kind === 'transfer') && !exclude?.has(c.id)))
    .map((c) => ({ value: String(c.id), label: labelOf(c) }))

  const subOptions: Option[] = categories
    .filter((c) => {
      if (sectionId == null || !isUnder(categories, c, sectionId)) return false
      if (c.id === value) return true // keep the current choice visible even if archived
      if (exclude?.has(c.id)) return false
      if (!c.is_active && c.kind !== 'transfer') return false
      if (parentMode && c.depth > MAX_PARENT_DEPTH) return false
      return true
    })
    .map((c) => ({ value: String(c.id), label: labelOf(c, section) }))

  if (parentMode && section) {
    subOptions.unshift({ value: String(section.id), label: `— ${section.name} —` })
  }

  const onSectionChange = (opt: Option | null) => {
    const next = opt ? Number(opt.value) : null
    setSectionId(next)
    onChange(parentMode ? next : null) // a section is a valid parent; otherwise clear the sub-category
  }

  const subDisabled = sectionId == null || subOptions.length === 0
  const subPlaceholder = sectionId == null ? (parentMode ? blank : 'Pick a category first') : blank

  const optionsForCascade = (level: number): Option[] => {
    const parentId = level === 0 ? null : chain[level - 1]
    if (level > 0 && parentId == null) return []
    return categories
      .filter((c) => c.depth === level && (level === 0 ? c.parent_id == null : c.parent_id === parentId))
      .filter((c) => c.is_active || c.id === chain[level])
      .filter((c) => !exclude?.has(c.id))
      .map((c) => ({ value: String(c.id), label: c.is_active ? c.name : `${c.name} (inactive)` }))
  }

  const onCascadeChange = (level: number, opt: Option | null) => {
    const next = chain.slice()
    next[level] = opt ? Number(opt.value) : null
    for (let i = level + 1; i < next.length; i++) next[i] = null
    setChain(next)
    let deepest: number | null = null
    for (const v of next) if (v != null) deepest = v
    onChange(deepest)
  }

  return (
    <span className="cat-pair" role="group" aria-required={required}>
      {cascade && !parentMode ? (
        levels.map((label, level) => {
          const opts = optionsForCascade(level)
          const disabled = level > 0 && (chain[level - 1] == null || opts.length === 0)
          const selected = opts.find((o) => o.value === String(chain[level])) ?? null
          return (
            <PairCol key={level} htmlFor={level === 0 ? id : id ? `${id}-l${level}` : undefined} label={label}>
              <Select
                inputId={level === 0 ? id : id ? `${id}-l${level}` : undefined}
                classNamePrefix="rs"
                menuPosition="fixed"
                menuPortalTarget={document.body}
                styles={selectStyles}
                isSearchable
                isClearable
                options={opts}
                value={selected}
                isDisabled={disabled}
                placeholder="Choose…"
                aria-label={label}
                onChange={(opt) => onCascadeChange(level, opt)}
              />
            </PairCol>
          )
        })
      ) : (
        <>
          <PairCol htmlFor={id} label={showLabels ? levels[0] : undefined}>
            <Select
              inputId={id}
              classNamePrefix="rs"
              menuPosition="fixed"
              menuPortalTarget={document.body}
              styles={selectStyles}
              isSearchable
              options={sectionOptions}
              value={sectionOptions.find((o) => o.value === String(sectionId)) ?? null}
              placeholder={parentMode ? blank : 'Choose…'}
              aria-label="Category"
              onChange={onSectionChange}
            />
          </PairCol>
          <PairCol htmlFor={id ? `${id}-sub` : undefined} label={showLabels ? levels[1] : undefined}>
            <Select
              inputId={id ? `${id}-sub` : undefined}
              classNamePrefix="rs"
              menuPosition="fixed"
              menuPortalTarget={document.body}
              styles={selectStyles}
              isSearchable
              options={subOptions}
              value={subOptions.find((o) => o.value === String(value)) ?? null}
              isDisabled={subDisabled}
              placeholder={subPlaceholder}
              aria-label="Sub-category"
              onChange={(opt) => onChange(opt ? Number(opt.value) : null)}
            />
          </PairCol>
        </>
      )}
    </span>
  )
}

interface CategoryFilterProps {
  categories: Category[]
  /** "" = any, "none" = unassigned, otherwise a category id as a string. */
  value: string
  onChange: (v: string) => void
  unassigned?: boolean
  id?: string
  /** Restrict the rendered levels to an inclusive [levelFrom, levelTo] slice of the configured levels. */
  levelFrom?: number
  levelTo?: number
}

/** One cascading select per configured level (a whole category matches its sub-categories). */
export function CategoryFilter({
  categories,
  value,
  onChange,
  unassigned = false,
  id,
  levelFrom = 0,
  levelTo,
}: CategoryFilterProps) {
  const levels = levelsOf(useCategoryConfig().data)
  const lastLevel = levelTo ?? levels.length - 1
  const byId = new Map(categories.map((c) => [c.id, c]))

  const chainOf = (raw: string): (number | null)[] => {
    const chain = levels.map(() => null as number | null)
    if (!raw || raw === 'none') return chain
    let cur: Category | undefined = byId.get(Number(raw))
    while (cur) {
      if (cur.depth < chain.length) chain[cur.depth] = cur.id
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined
    }
    return chain
  }

  const [chain, setChain] = useState<(number | null)[]>(() => chainOf(value))

  useEffect(() => {
    setChain(chainOf(value))
  }, [categories, value])

  const optionsFor = (level: number): Option[] => {
    const parentId = level === 0 ? null : chain[level - 1]
    if (level > 0 && parentId == null) return []
    const opts = categories
      .filter((c) => c.depth === level && (level === 0 ? c.parent_id == null : c.parent_id === parentId))
      .filter((c) => c.is_active || c.id === chain[level])
      .map((c) => ({ value: String(c.id), label: c.is_active ? c.name : `${c.name} (inactive)` }))
    if (level === 0 && unassigned) opts.unshift({ value: 'none', label: 'Unassigned' })
    return opts
  }

  const onLevelChange = (level: number, opt: Option | null) => {
    if (level === 0 && opt?.value === 'none') {
      setChain(levels.map(() => null))
      onChange('none')
      return
    }
    const next = chain.slice()
    next[level] = opt ? Number(opt.value) : null
    for (let i = level + 1; i < next.length; i++) next[i] = null
    setChain(next)
    let deepest: number | null = null
    for (const v of next) if (v != null) deepest = v
    onChange(deepest == null ? '' : String(deepest))
  }

  return (
    <span className="cat-pair">
      {levels.map((label, level) => {
        if (level < levelFrom || level > lastLevel) return null
        const opts = optionsFor(level)
        const disabled = level > 0 && (chain[level - 1] == null || opts.length === 0)
        const selected =
          level === 0 && unassigned && value === 'none'
            ? opts[0]
            : (opts.find((o) => o.value === String(chain[level])) ?? null)
        return (
          <PairCol key={level} htmlFor={level === 0 ? id : id ? `${id}-l${level}` : undefined} label={label}>
            <Select
              inputId={level === 0 ? id : id ? `${id}-l${level}` : undefined}
              classNamePrefix="rs"
              menuPosition="fixed"
              menuPortalTarget={document.body}
              styles={selectStyles}
              isSearchable
              isClearable
              options={opts}
              value={selected}
              isDisabled={disabled}
              placeholder={`Any ${label.toLowerCase()}`}
              aria-label={label}
              onChange={(opt) => onLevelChange(level, opt)}
            />
          </PairCol>
        )
      })}
    </span>
  )
}

interface AccountSelectProps {
  accounts: Account[]
  value: number | null
  onChange: (id: number | null) => void
  blank?: string
  id?: string
  clearable?: boolean
}

export function AccountSelect({ accounts, value, onChange, blank = '— none —', id, clearable = true }: AccountSelectProps) {
  const options: Option[] = accounts
    .filter((a) => a.is_active || a.id === value)
    .map((a) => ({ value: String(a.id), label: a.is_active ? a.name : `${a.name} (inactive)` }))
  return (
    <Select
      inputId={id}
      classNamePrefix="rs"
      menuPosition="fixed"
        menuPortalTarget={document.body}
      styles={selectStyles}
      isSearchable
      isClearable={clearable}
      options={options}
      value={options.find((o) => o.value === String(value)) ?? null}
      placeholder={blank}
      aria-label="Account"
      onChange={(opt) => onChange(opt ? Number(opt.value) : null)}
    />
  )
}
interface OptionSelectProps {
  options: Option[]
  value: string
  onChange: (value: string) => void
  id?: string
  label: string
  searchable?: boolean
}

export function OptionSelect({ options, value, onChange, id, label, searchable = false }: OptionSelectProps) {
  return (
    <Select
      inputId={id}
      classNamePrefix="rs"
      menuPosition="fixed"
      menuPortalTarget={document.body}
      styles={selectStyles}
      isSearchable={searchable}
      isClearable={false}
      options={options}
      value={options.find((o) => o.value === value) ?? null}
      aria-label={label}
      onChange={(opt) => opt && onChange(opt.value)}
    />
  )
}
