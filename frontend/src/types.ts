export type Kind = string
export type AccountKind = 'bank' | 'cash' | 'savings' | 'investment' | 'debt'

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
  /** True when kind === 'debt' (a loan). */
  is_loan: boolean
  /** Positive amount owed for a loan; equal to the balance for every other account. */
  owed_cents: number
  loan_type: string | null
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
  is_income: boolean
  account_id: number | null
  account_name: string | null
  to_account_id: number | null
  to_name: string | null
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

export type PlanConfigKind = 'money' | 'int' | 'date' | 'text' | 'select' | 'category' | 'categories' | 'paycheck'

export interface PlanConfigField {
  key: string
  label: string
  kind: PlanConfigKind
  placeholder: string
  help: string
  options: { key: string; label: string }[]
}

export interface PlanType {
  key: string
  label: string
  description: string
  account_aware: boolean
  implemented: boolean
  headline: string
  item_kinds: string[]
  config_fields: PlanConfigField[]
}

export interface PlanEvent {
  item_id: number | null
  date: string | null
  description: string
  category_id: number | null
  category_path: string
  account_id: number | null
  amount_cents: number
  direction: 'in' | 'out'
  item_kind: string
  source: string
  ref_id: number | null
  matched_transaction_id: number | null
  matched_date: string | null
  actual_cents: number | null
  variance_cents: number | null
  balance_cents?: number | null
}

export interface PlanDerived {
  kind: string
  note?: string
  headline_cents?: number
  headline_pct?: number
  events: PlanEvent[]
  window?: { start: string; end: string }
  lookahead_paychecks?: number
  paycheck?: { id: number; description: string; amount_cents: number } | null
  paychecks?: { date: string }[]
  opening_balance_cents?: number
  inflow_cents?: number
  outflow_cents?: number
  net_cents?: number
  variable_spending_cents?: number
  variable_category_count?: number
  buffer_cents?: number
  safe_to_spend_cents?: number
  end_balance_cents?: number
  lowest_balance_cents?: number
  target_cents?: number
  funded_cents?: number
  remaining_cents?: number
  progress_pct?: number
  target_date?: string | null
  months_remaining?: number | null
  required_monthly_cents?: number | null
  underspend_cents?: number
  categories?: PlanSavingsCategory[]
  months?: PlanSavingsMonth[]
  monthly_payment_cents?: number
  apr_pct?: number
  strategy?: string
  months_to_payoff?: number | null
  total_interest_cents?: number
  debts?: PlanDebt[]
  schedule?: { month: number; remaining_cents: number }[]
  budget_cents?: number
  estimate_cents?: number
  income_cents?: number
  expense_cents?: number
  month?: string
  income_adjust_pct?: number
  expense_adjust_pct?: number
  base_income_cents?: number
  base_expense_cents?: number
  base_net_cents?: number
  purchase_cents?: number
  purchase_date?: string
  account_name?: string | null
  balance_before_cents?: number
  balance_after_cents?: number
  affordable?: boolean
  shortfall_cents?: number
  funding?: PlanFunding | null
}

export interface PlanFunding {
  category_id: number
  category_path: string
  account_id: number | null
  account_name: string | null
  in_cents: number
  out_cents: number
  net_cents: number
  transactions: PlanFundingTxn[]
}

export interface PlanFundingTxn {
  id: number
  date: string
  description: string
  account_id: number | null
  account_name: string | null
  amount_cents: number
  direction: 'in' | 'out'
  signed_cents: number
}

export interface PlanDebt {
  id: number
  name: string
  initial_cents: number
  interest_cents: number
  payoff_month: number | null
}

export interface PlanSavingsCategory {
  category_id: number
  name: string
  depth: number
  has_children: boolean
  budget_cents: number
  actual_cents: number
  remaining_cents: number
}

export interface PlanSavingsMonth {
  month: string
  kind: 'actual' | 'projected'
  income_cents: number
  expense_cents: number
  net_cents: number
  cumulative_cents: number
}

export interface PlanItem {
  id: number
  date: string | null
  description: string
  category_id: number | null
  category_path: string
  account_id: number | null
  account_name: string | null
  amount_cents: number
  direction: 'in' | 'out'
  item_kind: string
  source: string
  matched_transaction_id: number | null
  matched_date: string | null
}

export interface Plan {
  id: number
  name: string
  type: string
  type_label: string
  status: string
  account_id: number | null
  account_name: string | null
  start_date: string | null
  end_date: string | null
  notes: string
  config: Record<string, unknown>
  sort_order: number
  derived: PlanDerived
  item_count: number
  items?: PlanItem[]
  events?: PlanEvent[]
}

export interface PlanBody {
  name: string
  type: string
  account_id: number | null
  start_date: string | null
  end_date: string | null
  notes: string
  status: string
  config: Record<string, unknown>
}

export interface PlanItemBody {
  date: string | null
  description: string
  category_id: number | null
  account_id: number | null
  amount: string
  direction: 'in' | 'out'
  item_kind: string
  matched_transaction_id: number | null
}

export interface Loan {
  account_id: number
  name: string
  kind: AccountKind
  is_active: boolean
  opening_balance_cents: number
  opening_date: string | null
  balance_cents: number
  /** Positive amount owed, the inverse of the signed ledger balance. */
  owed_cents: number
  has_details: boolean
  loan_type: string
  loan_type_label: string
  lender: string
  original_principal_cents: number
  /** Part of the balance a final balloon/buyout settles (a lease residual). */
  residual_cents: number
  /** Owed minus the residual: what the monthly payments are working down. */
  amortizing_owed_cents: number
  principal_basis_cents: number
  principal_paid_cents: number
  payoff_pct: number
  rate_bps: number
  rate_pct: number
  is_interest_bearing: boolean
  min_payment_cents: number
  due_day: number
  next_due_date: string | null
  credit_limit_cents: number
  utilization_pct: number | null
  reference: string
  notes: string
  transaction_count: number
  last_activity: string | null
}

export interface LoanHistoryRow {
  txn_id: number
  date: string
  description: string
  delta_cents: number
  owed_delta_cents: number
  owed_cents: number
  is_planned: boolean
}

export interface LoanDetail extends Loan {
  history: LoanHistoryRow[]
}

export interface LoanTypeTotal {
  key: string
  label: string
  owed_cents: number
  count: number
}

export interface LoanTotals {
  owed_cents: number
  count: number
  original_cents: number
  residual_cents: number
  principal_paid_cents: number
  balance_cents: number
  by_type: LoanTypeTotal[]
}

export interface LoanTrendPoint {
  month: string
  owed_cents: number
}

export interface MissingLoanDetails {
  account_id: number
  name: string
}

export interface LoansResponse {
  items: Loan[]
  totals: LoanTotals
  trend: LoanTrendPoint[]
  missing_details: MissingLoanDetails[]
}

export interface LoanTypeConfig {
  types: AccountType[]
}

export interface LoanDetailsInput {
  loan_type: string
  lender: string
  original_principal: string
  residual: string
  rate: string
  is_interest_bearing: boolean
  min_payment: string
  due_day: number
  credit_limit: string
  reference: string
  notes: string
}

export interface LoanCreateBody {
  name: string
  owed: string
  opening_date: string | null
  is_active: boolean
  details: LoanDetailsInput
  disbursement_account_id: number | null
  disbursement_amount: string
  disbursement_date: string | null
  disbursement_description: string
}

export interface LoanUpdateBody {
  name: string
  owed: string
  opening_date: string | null
  is_active: boolean
  details: LoanDetailsInput
}

export interface LoanPaymentBody {
  from_account_id: number | null
  amount: string
  date: string
  description: string
  notes: string | null
}

export interface LedgerIssue {
  code: string
  message: string
  count: number
  txn_ids: number[]
}

export interface LedgerCheck {
  ok: boolean
  issues: LedgerIssue[]
  scanned: {
    transactions: number
    transfers: number
    reimbursements: number
  }
}
