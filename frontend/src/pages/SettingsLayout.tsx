import { Suspense } from 'react'
import { AlertTriangle, Filter, Repeat, SlidersHorizontal, Tags, Wallet } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { Tooltip } from 'react-tooltip'

const TABS = [
  { to: 'categories', label: 'Categories', icon: Tags },
  { to: 'accounts', label: 'Accounts', icon: Wallet },
  { to: 'recurring', label: 'Recurring', icon: Repeat },
  { to: 'import-rules', label: 'Import rules', icon: Filter },
  { to: 'preferences', label: 'Preferences', icon: SlidersHorizontal },
  { to: 'danger', label: 'Danger', icon: AlertTriangle },
]

export default function SettingsLayout() {
  return (
    <>
      <h1>Settings</h1>
      <div className="tabs" role="tablist">
        {TABS.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `tab with-icon${isActive ? ' active' : ''}`}>
            <Icon size={15} /> {label}
          </NavLink>
        ))}
      </div>
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
      <Tooltip id="settings-tip" />
    </>
  )
}
