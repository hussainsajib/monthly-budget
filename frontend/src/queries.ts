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

/** Server-sorted variant for the accounts table; pickers keep using the shared `useAccounts` entry. */
export const useSortedAccounts = (sort: string, dir: string) =>
  useQuery({ queryKey: ['accounts', 'sorted', sort, dir], queryFn: () => api.accounts({ sort, dir }) })

/** Server-sorted variant for the recurring table. */
export const useSortedRecurring = (sort: string, dir: string) =>
  useQuery({ queryKey: ['recurring', sort, dir], queryFn: () => api.recurring({ sort, dir }) })
