import { useState, type FormEvent } from 'react'
import { Beaker, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react'
import { getSupabaseErrorMessage, supabase } from '../lib/supabase'
import { useAuth } from './AuthProvider'

// Shown once after a researcher opens their invitation link (or a password-reset link),
// so they can sign in again later with their email and this password.
export default function SetPasswordPage() {
  const { profile, session, passwordSet, signOut } = useAuth()
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [show, setShow] = useState(false)
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    if (password.length < 8) { setError('Use at least 8 characters.'); return }
    if (password !== confirm) { setError('The two passwords do not match.'); return }
    setBusy(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (updateError) { setError(await getSupabaseErrorMessage(updateError, 'The password could not be saved.')); return }
    window.history.replaceState(null, '', '/') // drop the one-time link from the address bar
    passwordSet()
  }
  return <main className="auth-shell"><section className="auth-brand"><div className="brand-mark"><Beaker size={22}/></div><span>labventory</span><small>chemical intelligence</small><div className="auth-quote"><b>Welcome to the lab.</b><p>Choose a password to finish setting up your account.</p></div></section><section className="auth-card"><div className="auth-card-inner">
    <div className="auth-heading"><span className="eyebrow">ACCOUNT SETUP</span><h1>Set your password</h1><p>{profile?.full_name && profile.full_name !== 'Pending researcher' ? `${profile.full_name} · ` : ''}{session?.user.email}</p></div>
    <form onSubmit={submit}>
      <label>New password<div className="auth-input"><LockKeyhole size={16}/><input type={show ? 'text' : 'password'} required value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password"/><button type="button" onClick={() => setShow(!show)} aria-label="Toggle password visibility">{show ? <EyeOff size={16}/> : <Eye size={16}/>}</button></div></label>
      <label>Confirm password<div className="auth-input"><LockKeyhole size={16}/><input type={show ? 'text' : 'password'} required value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Repeat the password" autoComplete="new-password"/></div></label>
      {error && <div className="auth-error">{error}</div>}
      <button className="primary auth-submit" disabled={busy}>{busy ? 'Saving...' : 'Save password and continue'}</button>
    </form>
    <button className="recover" onClick={() => void signOut()}>Not you? Sign out</button>
    <div className="auth-note"><ShieldCheck size={15}/><span>Researchers can view inventory, record chemical usage and book Flash chromatography. Account management is reserved for the administrator.</span></div>
  </div></section></main>
}
