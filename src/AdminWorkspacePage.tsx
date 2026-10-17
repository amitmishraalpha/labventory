import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Download, FileSpreadsheet, RefreshCw, UserPlus, UserX } from 'lucide-react'
import * as XLSX from 'xlsx'
import { getSupabaseErrorMessage, supabase } from './lib/supabase'
import { useAuth } from './auth/AuthProvider'
import { initialOf, percentLeft, useInventory } from './data/InventoryProvider'
import ImportPanel from './import/ImportPanel'
import PubChemLink from './lib/PubChemLink'

type User = { id: string; email: string; full_name: string; account_status: string; invited_at: string | null; created_at: string }
type Activity = { id: string; action_type: string; actor_user_id: string; target_user_id: string | null; metadata: Record<string, any>; created_at: string }
type Low = { id: string; chemical: string; cas: string | null; make: string | null; place: string; current: number; unit: string; initial: number; initialUnit: string; percentage: number }
const tabs = [['researchers', 'Researchers'], ['import', 'Import'], ['export', 'Export'], ['activity', 'Activity']] as const
type Tab = typeof tabs[number][0]
const actionLabels: Record<string, string> = { INVENTORY_IMPORT: 'Inventory imported', INVITATION_SENT: 'Invitation sent', INVITATION_ACCEPTED: 'Invitation accepted', CHEMICAL_USAGE: 'Usage recorded', RESEARCHER_SUSPENDED: 'Researcher deactivated', RESEARCHER_ACTIVE: 'Researcher restored', RESEARCHER_REMOVED: 'Researcher removed' }

function describe(event: Activity, names: Map<string, string>) {
  const m = event.metadata ?? {}
  if (event.action_type === 'INVENTORY_IMPORT') return `${m.file_name ?? 'File'}: ${m.imported_rows ?? 0} of ${m.total_rows ?? 0} rows imported, ${m.rejected_rows ?? 0} rejected · chemicals ${m.chemicals?.matched ?? 0} matched / ${m.chemicals?.created ?? 0} new`
  if (event.action_type === 'CHEMICAL_USAGE') return `${m.quantity ?? ''} ${m.unit ?? ''}`.trim()
  const target = event.target_user_id ? names.get(event.target_user_id) : null
  return target ?? m.email ?? ''
}

export default function AdminWorkspacePage() {
  const { profile } = useAuth(); const navigate = useNavigate(); const { bottles, refresh: refreshInventory } = useInventory()
  // Tab lives in the URL so Back/Forward and reloads keep the Admin's place.
  const [params, setParams] = useSearchParams(); const tab: Tab = tabs.some(([value]) => value === params.get('tab')) ? params.get('tab') as Tab : 'researchers'
  const [users, setUsers] = useState<User[]>([]); const [names, setNames] = useState<Map<string, string>>(new Map()); const [events, setEvents] = useState<Activity[]>([])
  const [search, setSearch] = useState(''); const [email, setEmail] = useState(''); const [name, setName] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const [u, a] = await Promise.all([
      supabase.from('profiles').select('id,email,full_name,role,account_status,invited_at,created_at').order('created_at', { ascending: false }),
      supabase.from('activity_log').select('id,action_type,actor_user_id,target_user_id,metadata,created_at').order('created_at', { ascending: false }).limit(200),
    ])
    if (u.error) setError(u.error.message)
    else { setUsers((u.data ?? []).filter(row => row.role === 'RESEARCHER')); setNames(new Map((u.data ?? []).map(row => [row.id, row.full_name || row.email]))) }
    if (a.error) setError(current => current || (a.error.code === 'PGRST205' ? 'Activity history is unavailable: public.activity_log has not been created in Supabase yet. Apply migration 20261018090000_activity_log_and_inventory_import.sql.' : a.error.message))
    else setEvents((a.data ?? []) as Activity[])
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  const invite = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); setMessage(''); const result = await supabase.functions.invoke('invite-researcher', { body: { email: email.trim(), full_name: name.trim() || null } }); setBusy(false); if (result.error) setError(await getSupabaseErrorMessage(result.error, 'The invitation function returned an error. Check its Supabase logs.')); else { setMessage(`Invitation sent to ${email.trim()}.`); setEmail(''); setName(''); await load() } }
  const deactivate = async (user: User) => {
    if (!window.confirm(`Deactivate ${user.email}?`)) return
    setError(''); setMessage('')
    const result = await supabase.from('profiles').update({ account_status: 'suspended', updated_at: new Date().toISOString() }).eq('id', user.id).eq('role', 'RESEARCHER').select('id')
    if (result.error) { setError(result.error.message); return }
    if (!result.data?.length) { setError(`${user.email} was not updated. The Admin update policy may be missing in Supabase.`); return }
    if (profile) await supabase.from('activity_log').insert({ actor_user_id: profile.id, action_type: 'RESEARCHER_SUSPENDED', target_user_id: user.id, metadata: { email: user.email } })
    setMessage(`${user.email} deactivated.`); await load()
  }
  // Low quantity: remaining below 20% of the initial quantity (shared rule, see percentLeft).
  const low = useMemo<Low[]>(() => bottles.flatMap(b => {
    const percentage = percentLeft(b); const initial = initialOf(b)
    return percentage !== null && percentage < 20 && initial ? [{ id: b.id, chemical: b.chemical, cas: b.cas, make: b.manufacturer, place: [b.place, b.tray].filter(Boolean).join(' / '), current: b.quantity, unit: b.unit ?? '', initial: initial.value, initialUnit: initial.unit ?? '', percentage }] : []
  }).sort((a, b) => a.percentage - b.percentage), [bottles])
  // Same columns as the laboratory chemicals register, one row per physical bottle.
  const exportRows = useMemo(() => bottles.map((b, index) => ({ 'S.No': index + 1, 'Chemical Name': b.chemical, 'Cas No': b.cas ?? '', Make: b.manufacturer ?? '', 'Bottle size': b.size != null ? `${b.size} ${b.sizeUnit ?? ''}`.trim() : '', 'Approx available quantity (g/mL)': `${b.quantity} ${b.unit ?? ''}`.trim(), Place: b.place ?? '', 'Tray No.': b.tray ?? '' })), [bottles])
  const exportFile = (type: 'csv' | 'xlsx') => { const sheet = XLSX.utils.json_to_sheet(exportRows); if (type === 'csv') { const url = URL.createObjectURL(new Blob([XLSX.utils.sheet_to_csv(sheet)], { type: 'text/csv' })); const link = document.createElement('a'); link.href = url; link.download = 'labventory-inventory.csv'; link.click(); URL.revokeObjectURL(url) } else { const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Inventory'); XLSX.writeFile(book, 'labventory-inventory.xlsx') } }
  const filtered = useMemo(() => users.filter(user => `${user.email} ${user.full_name} ${user.account_status}`.toLowerCase().includes(search.toLowerCase())), [users, search])
  const onImported = useCallback(async () => { await Promise.all([refreshInventory(), load()]) }, [refreshInventory, load])

  return <div className="admin-page"><div className="admin-page-header"><div><button className="secondary admin-back" onClick={() => navigate('/')}><ArrowLeft size={15}/> Back to dashboard</button><span className="eyebrow">ADMINISTRATION</span><h2>Research management</h2><p>Researchers, imports, exports, and activity history.</p></div><button className="secondary" onClick={() => void Promise.all([load(), refreshInventory()])}><RefreshCw size={15}/> Refresh</button></div><nav className="admin-tabs">{tabs.map(([value, label]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setParams(value === 'researchers' ? {} : { tab: value })}>{label}</button>)}</nav>{message && <div className="admin-success">{message}</div>}{error && <div className="user-error">{error}</div>}
    {tab === 'import' ? <ImportPanel onImported={onImported}/> : loading ? <div className="loading-row">Loading Admin data...</div> : tab === 'researchers' ? <><section className="admin-stats"><div><strong>{users.filter(user => user.account_status === 'active').length}</strong><span>Active researchers</span></div><div><strong>{users.filter(user => user.account_status === 'invited').length}</strong><span>Pending invitations</span></div><div><strong>{low.length}</strong><span>Low-quantity bottles</span></div></section><form className="panel admin-card" onSubmit={invite}><h2>Invite researcher</h2><p>Secure invitation through Supabase Auth.</p><input type="email" required placeholder="Email address" value={email} onChange={event => setEmail(event.target.value)}/><input placeholder="Full name" value={name} onChange={event => setName(event.target.value)}/><button className="primary" disabled={busy}><UserPlus size={16}/>{busy ? 'Sending...' : 'Send invitation'}</button></form><section className="panel admin-section"><h2>Researchers</h2><input className="admin-search" placeholder="Search researchers" value={search} onChange={event => setSearch(event.target.value)}/><div className="table-wrap"><table><thead><tr><th>NAME</th><th>EMAIL</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{filtered.map(user => <tr key={user.id}><td>{user.full_name}</td><td>{user.email}</td><td>{user.account_status}</td><td>{user.account_status === 'active' && <button className="table-action danger" onClick={() => void deactivate(user)}><UserX size={13}/> Deactivate</button>}</td></tr>)}{!filtered.length && <tr><td colSpan={4}>No researchers found.</td></tr>}</tbody></table></div></section><LowTable rows={low}/></>
    : tab === 'export' ? <section className="panel admin-section"><h2>Export inventory</h2><p>{exportRows.length} bottles loaded from Supabase.</p><div className="export-actions"><button className="primary" onClick={() => exportFile('xlsx')}><FileSpreadsheet size={16}/> Download XLSX</button><button className="secondary" onClick={() => exportFile('csv')}><Download size={16}/> Download CSV</button></div></section>
    : <section className="panel admin-section"><h2>Activity history</h2><p>Append-only audit trail. Only the Admin can read it; nobody can edit or delete entries.</p>{events.map(event => <div className="activity-row" key={event.id}><b>{actionLabels[event.action_type] ?? event.action_type}</b><span>{new Date(event.created_at).toLocaleString()} · {names.get(event.actor_user_id) ?? event.actor_user_id}</span><small>{describe(event, names)}</small></div>)}{!events.length && <p>No activity records found.</p>}</section>}</div>
}
function LowTable({ rows }: { rows: Low[] }) { return <section className="panel admin-section"><h2>Low-quantity inventory</h2><p>Bottles whose remaining quantity is below 20% of the initial quantity. Updates as soon as a researcher records usage.</p><div className="table-wrap"><table><thead><tr><th>CHEMICAL NAME</th><th>CAS NO</th><th>MAKE</th><th>PLACE / TRAY</th><th>REMAINING</th><th>INITIAL</th><th>% LEFT</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><b>{row.chemical}</b> <PubChemLink name={row.chemical} cas={row.cas}/></td><td className="mono">{row.cas ?? '—'}</td><td>{row.make ?? '—'}</td><td>{row.place || '—'}</td><td><b>{row.current} {row.unit}</b></td><td>{row.initial} {row.initialUnit}</td><td><b className="low-note">{row.percentage.toFixed(1)}%</b></td></tr>)}{!rows.length && <tr><td colSpan={7}>No bottles are below 20% of their initial quantity.</td></tr>}</tbody></table></div></section> }
