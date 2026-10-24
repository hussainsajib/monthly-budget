import { Suspense, lazy } from 'react'
import { Link, NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { Bar } from './components/table'

// Each page is a separate chunk so the shell stays small and vendors are shared.
const AccountsTab = lazy(() => import('./pages/AccountsTab'))
const BudgetPage = lazy(() => import('./pages/BudgetPage'))
const CashflowPage = lazy(() => import('./pages/CashflowPage'))
const CategoriesTab = lazy(() => import('./pages/CategoriesTab'))
const DangerTab = lazy(() => import('./pages/DangerTab'))
const ImportPage = lazy(() => import('./pages/ImportPage'))
const ImportRulesTab = lazy(() => import('./pages/ImportRulesTab'))
const LoanDetailPage = lazy(() => import('./pages/LoanDetailPage'))
const LoansPage = lazy(() => import('./pages/LoansPage'))
const LoanTypesTab = lazy(() => import('./pages/LoanTypesTab'))
const NetBreakdownPage = lazy(() => import('./pages/NetBreakdownPage'))
const PlanDetailPage = lazy(() => import('./pages/PlanDetailPage'))
const PlanPage = lazy(() => import('./pages/PlanPage'))
const PreferencesTab = lazy(() => import('./pages/PreferencesTab'))
const RecurringTab = lazy(() => import('./pages/RecurringTab'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const SettingsLayout = lazy(() => import('./pages/SettingsLayout'))
const TransactionEditPage = lazy(() => import('./pages/TransactionEditPage'))
const TransactionsPage = lazy(() => import('./pages/TransactionsPage'))

const LINKS = [
  { to: '/transactions', label: 'Transactions' },
  { to: '/budget', label: 'Budget' },
  { to: '/cashflow', label: 'Cash flow' },
  { to: '/loans', label: 'Loans' },
  { to: '/plan', label: 'Plan' },
  { to: '/reports', label: 'Report' },
]

const linkClass = ({ isActive }: { isActive: boolean }) => `link${isActive ? ' active' : ''}`

function Layout() {
  return (
    <>
      <nav aria-label="Primary">
        <div className="inner">
          <Link to="/" className="brand">Monthly Budget</Link>
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={linkClass}>
              {l.label}
            </NavLink>
          ))}
          <NavLink to="/settings" className={(s) => `${linkClass(s)} push`} aria-label="Settings" title="Settings">
            <span className="nav-icon" aria-hidden="true" />
          </NavLink>
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
        <Route path="reports/net/:month" element={<NetBreakdownPage />} />
        <Route path="cashflow" element={<CashflowPage />} />
        <Route path="loans" element={<LoansPage />} />
        <Route path="loans/:id" element={<LoanDetailPage />} />
        <Route path="plan" element={<PlanPage />} />
        <Route path="plan/:id" element={<PlanDetailPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="categories" replace />} />
          <Route path="categories" element={<CategoriesTab />} />
          <Route path="accounts" element={<AccountsTab />} />
          <Route path="recurring" element={<RecurringTab />} />
          <Route path="loan-types" element={<LoanTypesTab />} />
          <Route path="import-rules" element={<ImportRulesTab />} />
          <Route path="preferences" element={<PreferencesTab />} />
          <Route path="danger" element={<DangerTab />} />
        </Route>
        <Route path="*" element={<Navigate to="/transactions" replace />} />
      </Route>
    </Routes>
  )
}
