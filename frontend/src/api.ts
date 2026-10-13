import type {
  Account,
  AccountConfig,
  Cashflow,
  Category,
  CategoryConfig,
  BudgetMonth,
  DuplicateCandidate,
  ImportPreviewRow,
  ImportRule,
  ImportRuleBody,
  Recurring,
  RecurringBody,
  Report,
  Suggestion,
  Transfer,
  TransferBody,
  Txn,
  TxnBody,
  TxnPage,
} from './types'

export class ApiError extends Error {}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  if (!res.ok) {
    let message = res.statusText || `Request failed (${res.status})`
    try {
      const data = await res.json()
      const detail = data?.detail
      if (typeof detail === 'string') message = detail
      else if (Array.isArray(detail) && detail[0]?.msg) message = detail[0].msg
    } catch {
      // keep the status text
    }
    throw new ApiError(message)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

const get = <T>(url: string) => request<T>('GET', url)
const post = <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {})
const put = <T>(url: string, body: unknown) => request<T>('PUT', url, body)
const del = <T = void>(url: string) => request<T>('DELETE', url)

function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') sp.set(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export interface CategoryBody {
  name: string
  parent_id: number | null
  kind: string
  budget: string
  description: string
  sort_order: number
  is_active: boolean
}

export interface AccountBody {
  name: string
  kind: string
  opening_balance: string
  opening_date: string | null
  is_active: boolean
}

export const api = {
  categories: (includeSystem = false) =>
    get<Category[]>(`/categories${qs(includeSystem ? { include_system: 'true' } : {})}`),
  createCategory: (b: Partial<CategoryBody> & { name: string }) => post<{ id: number }>('/categories', b),
  updateCategory: (id: number, b: CategoryBody) => put<{ id: number }>(`/categories/${id}`, b),
  deleteCategory: (id: number, moveTo: number | null) =>
    del(`/categories/${id}${qs({ move_to_id: moveTo })}`),

  accounts: (params: Record<string, string | number | null | undefined> = {}) =>
    get<Account[]>(`/accounts${qs(params)}`),
  createAccount: (b: AccountBody) => post<Account>('/accounts', b),
  updateAccount: (id: number, b: AccountBody) => put<Account>(`/accounts/${id}`, b),
  deleteAccount: (id: number) => del(`/accounts/${id}`),

  transactions: (filters: Record<string, string | number | null | undefined>) =>
    get<TxnPage>(`/transactions${qs(filters)}`),
  transaction: (id: number) => get<Txn>(`/transactions/${id}`),
  recentTransactions: () => get<Txn[]>('/transactions/recent'),
  descriptions: () => get<string[]>('/transactions/descriptions'),
  transactionDuplicates: (params: { date: string; amount: string; account_id: number | null; exclude_id?: number }) =>
    get<DuplicateCandidate[]>(`/transactions/duplicates${qs(params)}`),
  createTransaction: (b: TxnBody) => post<Txn>('/transactions', b),
  updateTransaction: (id: number, b: TxnBody) => put<Txn>(`/transactions/${id}`, b),
  deleteTransaction: (id: number) => del(`/transactions/${id}`),
  clearTransactions: (importedOnly = false) =>
    del<{ deleted: number }>(`/transactions${qs({ imported_only: importedOnly ? 'true' : undefined })}`),
  suggest: (q: string) => get<Suggestion | null>(`/suggest${qs({ q })}`),

  createTransfer: (b: TransferBody) => post<{ transfer_id: string }>('/transfers', b),
  transfer: (id: string) => get<Transfer>(`/transfers/${id}`),
  updateTransfer: (id: string, b: TransferBody) => put<{ ok: boolean }>(`/transfers/${id}`, b),
  connectTransfer: (fromId: number, toId: number) =>
    post<{ transfer_id: string }>('/transfers/connect', { from_id: fromId, to_id: toId }),
  connectReimbursement: (firstId: number, secondId: number) =>
    post<{ reimbursement_id: string }>('/reimbursements/connect', { first_id: firstId, second_id: secondId }),

  recurring: (params: Record<string, string | number | null | undefined> = {}) =>
    get<Recurring[]>(`/recurring${qs(params)}`),
  createRecurring: (b: RecurringBody) => post<{ id: number }>('/recurring', b),
  updateRecurring: (id: number, b: RecurringBody) => put<{ id: number }>(`/recurring/${id}`, b),
  deleteRecurring: (id: number) => del(`/recurring/${id}`),

  importPreview: (form: FormData) => post<ImportPreviewRow[]>('/import/preview', form),
  importCommit: (accountId: number | null, rows: Omit<ImportPreviewRow, 'duplicate'>[]) =>
    post<{ imported: number }>('/import/commit', { account_id: accountId, rows }),
  applyImportRules: (
    accountId: number | null,
    rows: Pick<ImportPreviewRow, 'date' | 'description' | 'amount_cents' | 'direction' | 'category_id'>[],
  ) => post<{ category_ids: (number | null)[] }>('/import/apply-rules', { account_id: accountId, rows }),

  importRules: () => get<ImportRule[]>('/import-rules'),
  createImportRule: (b: ImportRuleBody) => post<{ id: number }>('/import-rules', b),
  updateImportRule: (id: number, b: ImportRuleBody) => put<{ ok: boolean }>(`/import-rules/${id}`, b),
  deleteImportRule: (id: number) => del(`/import-rules/${id}`),
  moveImportRule: (id: number, dir: 'up' | 'down') => post<{ ok: boolean }>(`/import-rules/${id}/move`, { dir }),

  budget: (month: string) => get<BudgetMonth>(`/budget${qs({ month })}`),
  setBudget: (month: string, categoryId: number, amount: string | null) =>
    put<{ ok: boolean }>(`/budget/${month}/${categoryId}`, { amount }),
  copyPreviousBudget: (month: string) => post<{ changed: number }>(`/budget/${month}/copy-previous`),
  generateBudget: (month: string, values: Record<number, number>) =>
    post<{ ok: boolean; changed: number }>(`/budget/${month}/generate`, { values }),

  report: (month: number | null) => get<Report>(`/reports${qs({ month })}`),
  cashflow: (accountId: number | null) => get<Cashflow>(`/cashflow${qs({ account_id: accountId })}`),
  setThresholds: (low: string, warn: string) =>
    put<{ low_balance_cents: number; warn_balance_cents: number }>('/settings/thresholds', { low, warn }),
  categoryConfig: () => get<CategoryConfig>('/settings/category-config'),
  setLevels: (levels: string[]) => put<{ levels: string[] }>('/settings/category-config', { levels }),
  accountConfig: () => get<AccountConfig>('/settings/account-config'),
}
