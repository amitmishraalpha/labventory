import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { authLinkError, authLinkType, supabase, supabaseConfigured } from '../lib/supabase'
import type { Profile } from './types'

export type ProfileStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error'
type AuthContextValue = {
  session: Session | null
  profile: Profile | null
  profileStatus: ProfileStatus
  profileError: string
  loading: boolean
  /** Opened from an invitation or password-reset email: the user must choose a password. */
  needsPassword: boolean
  passwordSet: () => void
  reloadProfile: () => Promise<void>
  signOut: () => Promise<void>
}
const AuthContext = createContext<AuthContextValue>({ session: null, profile: null, profileStatus: 'idle', profileError: '', loading: true, needsPassword: false, passwordSet: () => undefined, reloadProfile: async () => undefined, signOut: async () => undefined })
const profileColumns = 'id,email,full_name,role,account_status'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('idle')
  const [profileError, setProfileError] = useState('')
  const [sessionKnown, setSessionKnown] = useState(!supabaseConfigured)
  const [needsPassword, setNeedsPassword] = useState(authLinkType === 'invite' || authLinkType === 'recovery')
  // Guards against out-of-order responses when users switch or tokens refresh mid-request.
  const requestId = useRef(0)
  const loadedUserId = useRef<string | null>(null)
  const signedOutForBadLink = useRef(false)

  const loadProfile = useCallback(async (userId: string, background = false) => {
    const current = ++requestId.current
    if (!background) { setProfileStatus('loading'); setProfileError('') }
    let { data, error } = await supabase.from('profiles').select(profileColumns).eq('id', userId).maybeSingle()
    if (!error && data?.account_status === 'invited') {
      // First sign-in after accepting an invitation; the RPC only flips invited -> active for auth.uid().
      const activation = await supabase.rpc('activate_invited_user')
      if (!activation.error) ({ data, error } = await supabase.from('profiles').select(profileColumns).eq('id', userId).maybeSingle())
    }
    if (current !== requestId.current) return
    if (error) { setProfile(null); setProfileStatus('error'); setProfileError(error.message); return }
    loadedUserId.current = data ? userId : null
    setProfile(data as Profile | null)
    setProfileStatus(data ? 'ready' : 'missing')
  }, [])

  useEffect(() => {
    if (!supabaseConfigured) return
    const handle = (event: AuthChangeEvent, next: Session | null) => {
      // An invitation / reset link that failed (expired, already used) must not leave whoever was
      // signed in before in this browser (e.g. the Admin) in the workspace: sign them out so the
      // sign-in page shows why the link did not work.
      // Only the session that existed when the link was opened (INITIAL_SESSION); a normal sign-in
      // afterwards on the same page must not be undone.
      if (event === 'INITIAL_SESSION' && authLinkError && !signedOutForBadLink.current) {
        signedOutForBadLink.current = true
        window.history.replaceState(null, '', window.location.pathname) // drop the error fragment
        if (next) { void supabase.auth.signOut({ scope: 'local' }); return }
      }
      setSession(next); setSessionKnown(true)
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true)
      if (event === 'SIGNED_OUT') setNeedsPassword(false)
      const userId = next?.user.id ?? null
      if (!userId) { requestId.current++; loadedUserId.current = null; setProfile(null); setProfileStatus('idle'); setProfileError(''); return }
      // Token refreshes keep the same identity; don't flash the workspace or refetch.
      if (userId === loadedUserId.current && event !== 'USER_UPDATED') return
      const sameUser = userId === loadedUserId.current
      if (!sameUser) { loadedUserId.current = null; setProfile(null) }
      void loadProfile(userId, sameUser)
    }
    // onAuthStateChange emits INITIAL_SESSION on subscribe. Supabase calls are deferred out of
    // the callback because awaiting the client inside it can deadlock the auth lock.
    const { data: listener } = supabase.auth.onAuthStateChange((event, next) => { setTimeout(() => handle(event, next), 0) })
    return () => { requestId.current++; listener.subscription.unsubscribe() }
  }, [loadProfile])

  const reloadProfile = useCallback(async () => { if (session) await loadProfile(session.user.id, profileStatus === 'ready') }, [session, profileStatus, loadProfile])
  const signOut = useCallback(async () => { await supabase.auth.signOut() }, [])
  const loading = !sessionKnown || (Boolean(session) && (profileStatus === 'idle' || profileStatus === 'loading'))

  return <AuthContext.Provider value={{ session, profile, profileStatus, profileError, loading, needsPassword, passwordSet: () => setNeedsPassword(false), reloadProfile, signOut }}>{children}</AuthContext.Provider>
}
export function useAuth() { return useContext(AuthContext) }
