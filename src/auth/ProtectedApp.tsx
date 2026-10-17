import { useEffect, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { supabaseConfigured } from '../lib/supabase'
import { useAuth } from './AuthProvider'
import LoginPage from './LoginPage'
import AppShell, { ChemicalsPage, InventoryPage, OverviewPage } from '../AnalyticsDashboardApp'
import AdminWorkspacePage from '../AdminWorkspacePage'
import { InventoryProvider } from '../data/InventoryProvider'

function Blocked({ title, children }: { title: string; children: ReactNode }) {
  const { signOut } = useAuth()
  return <div className="auth-loading"><div><h1>{title}</h1>{children}<button className="secondary" onClick={() => void signOut()}>Sign out</button></div></div>
}

// UX guard only; Admin data and writes are enforced by RLS and SECURITY DEFINER checks.
function RequireAdmin({ children }: { children: ReactNode }) {
  const { profile } = useAuth()
  return profile?.role === 'ADMIN' ? <>{children}</> : <Navigate to="/" replace/>
}

export default function ProtectedApp() {
  const { session, profile, profileStatus, profileError, loading, reloadProfile } = useAuth()
  useEffect(() => { document.title = profile?.role === 'ADMIN' ? 'Labventory | Admin' : 'Labventory | Chemical intelligence' }, [profile])
  if (!supabaseConfigured) return <LoginPage />
  if (loading) return <div className="auth-loading">Loading secure workspace...</div>
  if (!session) return <LoginPage />
  if (profileStatus === 'error') return <Blocked title="Profile could not be loaded"><p>{profileError}</p><button className="primary" onClick={() => void reloadProfile()}>Try again</button></Blocked>
  if (!profile) return <Blocked title="No profile for this account"><p>{session.user.email} is signed in but has no Labventory profile. Contact the designated administrator.</p></Blocked>
  if (profile.account_status !== 'active') return <Blocked title="Access unavailable"><p>This account is {profile.account_status}. Contact the designated administrator.</p></Blocked>
  return <InventoryProvider key={profile.id}>
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="chemicals" element={<ChemicalsPage />} />
        <Route path="admin" element={<RequireAdmin><AdminWorkspacePage /></RequireAdmin>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  </InventoryProvider>
}
