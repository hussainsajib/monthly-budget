import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: () => api.categories() })

/** Categories including the transfer/reimbursement system categories, used only where tagging them is allowed (import). */
export const useImportCategories = () =>
  useQuery({ queryKey: ['categories', 'with-system'], queryFn: () => api.categories(true) })
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => api.accounts() })
export const useCategoryConfig = () => useQuery({ queryKey: ['category-config'], queryFn: api.categoryConfig })
export const useAccountConfig = () => useQuery({ queryKey: ['account-config'], queryFn: api.accountConfig })
export const useImportRules = () => useQuery({ queryKey: ['import-rules'], queryFn: api.importRules })

export const useRecurring = () => useQuery({ queryKey: ['recurring', 'all'], queryFn: () => api.recurring() })
export const usePlanTypes = () => useQuery({ queryKey: ['plan-types'], queryFn: api.planTypes })
export const usePlans = () => useQuery({ queryKey: ['plans'], queryFn: api.plans })
export const usePlan = (id: number) =>
  useQuery({ queryKey: ['plan', id], queryFn: () => api.plan(id), enabled: id > 0 })

/** Server-sorted variant for the accounts table; pickers keep using the shared `useAccounts` entry. */
export const useSortedAccounts = (sort: string, dir: string) =>
  useQuery({ queryKey: ['accounts', 'sorted', sort, dir], queryFn: () => api.accounts({ sort, dir }) })

/** Server-sorted variant for the recurring table. */
export const useSortedRecurring = (sort: string, dir: string) =>
  useQuery({ queryKey: ['recurring', sort, dir], queryFn: () => api.recurring({ sort, dir }) })

/** Server-sorted loans table plus its totals, debt trend and accounts still missing loan details. */
export const useLoans = (sort: string, dir: string, months = 12) =>
  useQuery({ queryKey: ['loans', sort, dir, months], queryFn: () => api.loans({ sort, dir, months }) })
export const useLoan = (id: number) =>
  useQuery({ queryKey: ['loan', id], queryFn: () => api.loan(id), enabled: id > 0 })
export const useLoanTypes = () => useQuery({ queryKey: ['loan-types'], queryFn: api.loanTypes })
