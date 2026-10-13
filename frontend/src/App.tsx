import { Suspense, lazy } from 'react'
import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { Bar } from './components/table'

// Each page is a separate chunk so the shell stays small and vendors are shared.
const AccountsTab = lazy(() => import('./pages/AccountsTab'))
const BudgetPage = lazy(() => import('./pages/BudgetPage'))
const CashflowPage = lazy(() => import('./pages/CashflowPage'))
const CategoriesTab = lazy(() => import('./pages/CategoriesTab'))
const DangerTab = lazy(() => import('./pages/DangerTab'))
const ImportPage = lazy(() => import('./pages/ImportPage'))
const ImportRulesTab = lazy(() => import('./pages/ImportRulesTab'))
const PreferencesTab = lazy(() => import('./pages/PreferencesTab'))
const RecurringTab = lazy(() => import('./pages/RecurringTab'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const SettingsLayout = lazy(() => import('./pages/SettingsLayout'))
const TransactionEditPage = lazy(() => import('./pages/TransactionEditPage'))
const TransactionsPage = lazy(() => import('./pages/TransactionsPage'))

const LINKS = [
  { to: '/transactions', label: 'Transactions' },
  { to: '/budget', label: 'Budget' },
  { to: '/reports', label: 'Report' },
  { to: '/cashflow', label: 'Cash flow' },
  { to: '/settings', label: 'Settings' },
]

function Layout() {
  return (
    <>
      <nav>
        <div className="inner">
          <span className="brand">Monthly Budget</span>
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => `link${isActive ? ' active' : ''}`}>
              {l.label}
            </NavLink>
          ))}
        </div>
      </nav>
      <main>
        <Suspense fallback={<div className="card loading-skeleton" aria-busy="true"><Bar w={220} /><Bar w={340} /></div>}>
          <Outlet />
        </Suspense>
      </main>
    </>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/transactions" replace />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="transactions/:id" element={<TransactionEditPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="budget" element={<BudgetPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="cashflow" element={<CashflowPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="categories" replace />} />
          <Route path="categories" element={<CategoriesTab />} />
          <Route path="accounts" element={<AccountsTab />} />
          <Route path="recurring" element={<RecurringTab />} />
          <Route path="import-rules" element={<ImportRulesTab />} />
          <Route path="preferences" element={<PreferencesTab />} />
          <Route path="danger" element={<DangerTab />} />
        </Route>
        <Route path="*" element={<Navigate to="/transactions" replace />} />
      </Route>
    </Routes>
  )
}
