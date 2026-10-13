export type Kind = string
export type AccountKind = 'bank' | 'credit' | 'cash'

export interface CategoryType {
  key: string
  label: string
  direction: 'in' | 'out'
}

export interface CategoryConfig {
  types: CategoryType[]
  levels: string[]
}

export interface AccountType {
  key: string
  label: string
}

export interface AccountConfig {
  types: AccountType[]
}

export interface Category {
  id: number
  name: string
  parent_id: number | null
  kind: Kind
  depth: number
  path: string
  budget_cents: number
  effective_budget_cents: number
  description: string
  sort_order: number
  is_active: boolean
  has_children: boolean
  child_count: number
  transaction_count: number
  recurring_count: number
}

export interface Account {
  id: number
  name: string
  kind: AccountKind
  opening_balance_cents: number
  opening_date: string | null
  current_balance_cents: number
  transaction_count: number
  transacted_cents: number
  is_active: boolean
}

export interface Txn {
  id: number
  date: string
  description: string
  category_id: number
  category_path: string
  kind: Kind
  account_id: number | null
  account_name: string | null
  amount_cents: number
  notes: string | null
  recurring_template_id: number | null
  recurring_description: string | null
  transfer_id: string | null
  transfer_account_id: number | null
  transfer_account_name: string | null
  reimbursement_id: string | null
  reimbursement_account_id: number | null
  reimbursement_account_name: string | null
  planned: boolean
}

export interface TxnPage {
  items: Txn[]
  total: number
  page: number
  pages: number
}

export interface TxnBody {
  date: string
  description: string
  category_id: number
  account_id: number | null
  amount: string
  notes: string
}

export interface DuplicateCandidate {
  id: number
  date: string
  description: string
  amount_cents: number
  account_name: string | null
}

export interface Transfer {
  transfer_id: string
  date: string
  description: string
  amount_cents: number
  from_account_id: number | null
  to_account_id: number | null
  notes: string | null
}

export interface TransferBody {
  date: string
  description: string
  amount: string
  from_account_id: number | null
  to_account_id: number | null
  notes: string | null
}

export type Schedule = {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  start: string // ISO date, first occurrence
  until: string | null // inclusive end date
  count: number | null // total occurrences
  by_weekday?: number[] // weekly: 0=Mon..6=Sun
  by_month_day?: number[] // monthly: days, -1 = last
  by_nth_weekday?: { week: number; weekday: number } // weekly: 1-5 or -1 = last
  month?: number // yearly: 1-12
  day?: number // yearly: 1-31 or -1 = last
}

export interface Recurring {
  id: number
  description: string
  category_id: number
  category_path: string
  account_id: number | null
  account_name: string | null
  amount_cents: number
  day_of_month: number
  schedule: Schedule | null
  is_active: boolean
}

export interface RecurringBody {
  description: string
  category_id: number
  account_id: number | null
  amount: string
  day_of_month: number
  schedule: Schedule | null
  is_active: boolean
}

export interface Suggestion {
  description: string
  category_id: number
  account_id: number | null
  amount: string
}

export interface ImportPreviewRow {
  date: string
  description: string
  amount_cents: number
  direction: 'in' | 'out'
  category_id: number | null
  duplicate: boolean
  key: string
  recurring_template_id: number | null
}

export interface ImportRule {
  id: number
  match_text: string
  amount_cents: number | null
  account_id: number
  account_name: string | null
  day_from: number | null
  day_to: number | null
  category_id: number
  category_path: string
  sort_order: number
  is_active: boolean
}

export interface ImportRuleBody {
  match_text: string
  amount: string | null
  account_id: number
  day_from: number | null
  day_to: number | null
  category_id: number
  sort_order: number
  is_active: boolean
}

export interface ReportRow {
  category_id: number
  name: string
  depth: number
  kind: Kind
  is_income: boolean
  has_children: boolean
  months: number[]
  budgets: number[]
  budget: number
  total: number
  avg: number
  variance: number
  status: '' | 'over' | 'under'
}

export interface Report {
  /** Rolling window months as 'YYYY-MM', oldest -> newest. */
  months: string[]
  /** 1-based position in ``months`` driving the category chart. */
  month: number
  net_months: number[]
  expense_budgets: number[]
  income_budgets: number[]
  net_budgets: number[]
  expense_budget: number
  income_budget: number
  avg_expense: number
  type_totals: Record<string, { months: number; budget: number }>
  rows: ReportRow[]
  chart: {
    spending: number[]
    income: number[]
    categories: string[]
    category_actual: number[]
    category_budget: number[]
  }
}

export interface LedgerRow {
  txn_id: number
  date: string
  description: string
  delta_cents: number
  balance_cents: number
  is_planned: boolean
  level: '' | 'warn' | 'low'
}

export interface Cashflow {
  account: Account | null
  ledger: {
    rows: LedgerRow[]
    current_balance_cents: number
    projected_balance_cents: number
    lowest: LedgerRow | null
    low_threshold_cents: number
    warn_threshold_cents: number
  } | null
}

export interface BudgetLine {
  category_id: number
  name: string
  parent_id: number | null
  depth: number
  kind: Kind
  has_children: boolean
  is_active: boolean
  default_cents: number
  budget_cents: number
  is_override: boolean
  actual_cents: number
  recurring_cents: number
  remaining_cents: number
}

export interface BudgetMonth {
  month: string
  income_budget: number
  expense_budget: number
  income_actual: number
  expense_actual: number
  unassigned: number
  type_totals: Record<string, { budget: number; actual: number }>
  lines: BudgetLine[]
}
