import { Fragment, useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, ArrowDownToLine, Beaker, Boxes, CalendarClock, ChevronDown, ChevronRight, Droplets, FlaskConical, History, LayoutDashboard, LogOut, MapPin, Menu, Magnet, PencilLine, RefreshCw, Scale, Search, ShoppingCart, Users, X } from 'lucide-react'
import { useAuth } from './auth/AuthProvider'
import { CATEGORY_LABEL, groupKey, groupTotal, isLowQuantity, lowSummary, percentLeft, qty, remainingText, startFor, useInventory, type Bottle, type Category, type ChemicalGroup, type Range, type Usage } from './data/InventoryProvider'
import RecordUsageModal from './usage/RecordUsageModal'
import { BottleHistoryModal } from './usage/UsageHistory'
import { EditBottleModal, StockCountModal } from './inventory/AdminBottleModals'
import { ExportMenu, LastUsed, Pager, StatusBadge, bottleStatus, usePaged } from './components/TableTools'
import { bottleColumns } from './solvents/SolventsPage'
import { isLowOrEmpty, orderPrefillFor } from './lowstock/LowStockPage'
import { OPEN } from './orders/OrdersPage'
import PubChemLink from './lib/PubChemLink'
import { matchesChemical } from './lib/search'
import { supabase } from './lib/supabase'
import { explainError } from './lib/errors'
import type { ExportColumn } from './lib/exporter'

type Point = { label: string; [unit: string]: string | number }
const ranges: Array<{ value: Range; label: string }> = [{ value: '30d', label: 'Last 30 days' }, { value: '3m', label: 'Last 3 months' }, { value: '6m', label: 'Last 6 months' }, { value: '12m', label: 'Last 12 months' }]
const colors = ['#287c70', '#d88a48', '#6d91af', '#9a78a7', '#c16b63']
function labelFor(date: Date, range: Range) { return range === '30d' ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) }
function makeUsagePoints(rows: Usage[], range: Range) { const points = new Map<string, Point>(); const units = [...new Set(rows.map(row => row.quantity_unit?.trim() || 'Unknown unit'))]; const cursor = startFor(range); const end = new Date(); const monthly = range !== '30d'; while (cursor <= end) { points.set(labelFor(cursor, range), { label: labelFor(cursor, range) }); monthly ? cursor.setMonth(cursor.getMonth() + 1) : cursor.setDate(cursor.getDate() + 1) } rows.forEach(row => { const key = labelFor(new Date(row.created_at), range); const point = points.get(key) ?? { label: key }; const unit = row.quantity_unit?.trim() || 'Unknown unit'; point[unit] = Number(point[unit] ?? 0) + Math.abs(Number(row.quantity_change) || 0); points.set(key, point) }); return { points: [...points.values()], units } }
function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?' }
const pageTitles: Record<string, string> = { '/': 'Overview', '/inventory': 'Inventory', '/chemicals': 'Chemicals', '/commercial-solvents': 'Commercial Solvents', '/nmr-solvents': 'NMR Solvents', '/low-stock': 'Low Stock', '/orders': 'Chemicals to Order', '/usage': 'Usage History', '/flash': 'Flash Chromatography', '/admin': 'Research Management' }

export default function AppShell() {
  const { profile, session, signOut, reloadProfile } = useAuth(); const { bottles } = useInventory(); const [mobileNav, setMobileNav] = useState(false); const location = useLocation()
  useEffect(() => { setMobileNav(false) }, [location.pathname])
  const displayName = profile?.full_name?.trim() || session?.user.email || 'Signed-in user'
  const count = (category: Category) => bottles.filter(b => b.category === category).length
  const low = bottles.filter(isLowOrEmpty).length
  const nav = [
    { to: '/', label: 'Overview', icon: LayoutDashboard }, { to: '/inventory', label: 'Inventory', icon: Boxes, badge: count('CHEMICAL') }, { to: '/chemicals', label: 'Chemicals', icon: FlaskConical },
    { to: '/commercial-solvents', label: 'Commercial Solvents', icon: Droplets, badge: count('COMMERCIAL_SOLVENT') }, { to: '/nmr-solvents', label: 'NMR Solvents', icon: Magnet, badge: count('NMR_SOLVENT') },
    { to: '/low-stock', label: 'Low Stock', icon: AlertTriangle, badge: low }, { to: '/orders', label: 'Chemicals to Order', icon: ShoppingCart }, { to: '/usage', label: 'Usage History', icon: History },
    { to: '/flash', label: 'Flash Chromatography', icon: CalendarClock }, ...(profile?.role === 'ADMIN' ? [{ to: '/admin', label: 'Research Management', icon: Users }] : []),
  ]
  const rename = async () => {
    const next = window.prompt('Your name as shown to others', profile?.full_name ?? '')
    if (next == null || next.trim() === (profile?.full_name ?? '').trim()) return
    const { error } = await supabase.rpc('update_my_profile', { p_full_name: next.trim() })
    if (error) window.alert(await explainError(error, 'Your name could not be changed.')); else await reloadProfile()
  }
  return <div className="app">{mobileNav && <button className="nav-backdrop" aria-label="Close menu" onClick={() => setMobileNav(false)}/>}<aside className={mobileNav ? 'sidebar open' : 'sidebar'}><div className="brand"><div className="brand-mark"><Beaker size={20}/></div><div><b>labventory</b><span>chemical intelligence</span></div><button className="close-nav" aria-label="Close menu" onClick={() => setMobileNav(false)}><X size={18}/></button></div><div className="workspace"><span className="workspace-dot"/>Research Lab <ChevronRight size={14}/></div><nav>{nav.map(({ to, label, icon: Icon, badge }) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}><Icon size={18}/><span>{label}</span>{badge ? <em>{badge}</em> : null}</NavLink>)}</nav><div className="sidebar-bottom"><button className="nav-item" onClick={() => void signOut()}><LogOut size={18}/><span>Sign out</span></button><div className="user" title={profile?.email || session?.user.email || undefined}><div className="avatar">{initials(displayName)}</div><div className="user-identity"><b>{displayName}</b><span>{profile?.role === 'ADMIN' ? 'Administrator' : 'Researcher'}</span></div><button className="rename" onClick={() => void rename()} aria-label="Change your name" title="Change your name"><PencilLine size={13}/></button></div></div></aside><main><header><button className="menu-btn" aria-label="Open menu" onClick={() => setMobileNav(true)}><Menu size={22}/></button><b className="mobile-title">{pageTitles[location.pathname] ?? 'Labventory'}</b><div className="crumb"><span>Workspace</span><ChevronRight size={14}/><b>{pageTitles[location.pathname] ?? 'Workspace'}</b></div></header><div className="content"><Outlet/></div></main></div>
}

function PageTitle({ title, eyebrow = 'LIVE SUPABASE ANALYTICS' }: { title: string; eyebrow?: string }) {
  const { refresh, loading, realtime } = useInventory(); const [busy, setBusy] = useState(false)
  return <div className="title-row"><div><p className="eyebrow">{eyebrow} <span>•</span> {realtime === 'live' ? 'REALTIME' : 'AUTO-REFRESH ON FOCUS'}</p><h1>{title}</h1><p className="subtitle">Every metric is calculated from current Supabase records.</p></div><button className="primary" disabled={busy || loading} onClick={async () => { setBusy(true); await refresh(); setBusy(false) }}><RefreshCw size={16}/> {busy ? 'Refreshing...' : 'Refresh data'}</button></div>
}

/** Open order requests by status (RLS: the Admin sees all, a researcher their own). */
function useOrderCounts() {
  const [counts, setCounts] = useState<Map<string, number> | null>(null)
  useEffect(() => {
    let live = true
    const load = async () => { const { data } = await supabase.from('chemical_order_requests').select('status'); if (!live) return; const map = new Map<string, number>(); (data ?? []).forEach((row: { status: string }) => map.set(row.status, (map.get(row.status) ?? 0) + 1)); setCounts(map) }
    void load()
    const channel = supabase.channel('overview-orders').on('postgres_changes', { event: '*', schema: 'public', table: 'chemical_order_requests' }, () => void load()).subscribe()
    return () => { live = false; void supabase.removeChannel(channel) }
  }, [])
  return counts
}

export function OverviewPage() {
  const { profile } = useAuth(); const { bottles, usage, range, setRange, loading, usageLoading, error, groups, people } = useInventory()
  const chemicalBottles = useMemo(() => bottles.filter(b => b.category === 'CHEMICAL'), [bottles])
  const chemicals = groups.filter(group => group.category === 'CHEMICAL' && group.bottles.length).length
  const lowAll = bottles.filter(isLowOrEmpty)
  const places = new Set(bottles.map(bottle => bottle.place).filter(Boolean)).size
  const orders = useOrderCounts()
  const openOrders = orders ? OPEN.reduce((sum, status) => sum + (orders.get(status) ?? 0), 0) : null
  const pending = orders ? (orders.get('Requested') ?? 0) + (orders.get('Pending Approval') ?? 0) : null
  const solventUsage = useMemo(() => usage.filter(u => u.category !== 'CHEMICAL'), [usage])
  const solventTotal = useMemo(() => { const sums = new Map<string, number>(); solventUsage.forEach(u => sums.set(u.quantity_unit ?? '', (sums.get(u.quantity_unit ?? '') ?? 0) - u.quantity_change)); return [...sums].map(([unit, sum]) => `${Number(sum.toFixed(2))} ${unit}`).join(' + ') || '0' }, [solventUsage])
  const makeData = useMemo(() => { const counts = new Map<string, number>(); chemicalBottles.forEach(bottle => { const make = bottle.manufacturer?.trim() || 'Make not recorded'; counts.set(make, (counts.get(make) ?? 0) + 1) }); return [...counts].map(([name, count]) => ({ name, bottles: count })).sort((a, b) => b.bottles - a.bottles).slice(0, 8) }, [chemicalBottles])
  const usageSeries = useMemo(() => makeUsagePoints(usage, range), [usage, range])
  const solventSeries = useMemo(() => makeUsagePoints(solventUsage, range), [solventUsage, range])
  const topSolvents = useMemo(() => { const counts = new Map<string, number>(); solventUsage.forEach(u => counts.set(u.chemical, (counts.get(u.chemical) ?? 0) + 1)); return [...counts].map(([name, entries]) => ({ name, entries })).sort((a, b) => b.entries - a.entries).slice(0, 8) }, [solventUsage])
  const byResearcher = useMemo(() => { const counts = new Map<string, number>(); usage.forEach(u => { const name = u.user_id === profile?.id ? 'You' : u.user_name ?? people.get(u.user_id) ?? 'Unknown'; counts.set(name, (counts.get(name) ?? 0) + 1) }); return [...counts].map(([name, entries]) => ({ name, entries })).sort((a, b) => b.entries - a.entries).slice(0, 8) }, [usage, people, profile?.id])
  const lowByCategory = useMemo(() => (Object.keys(CATEGORY_LABEL) as Category[]).map(category => ({ name: `${CATEGORY_LABEL[category]}s`, items: lowAll.filter(b => b.category === category).length })), [lowAll])
  const ordersByStatus = useMemo(() => (orders ? [...orders].map(([name, count]) => ({ name, requests: count })) : []), [orders])
  const lowGroups = useMemo(() => groups.filter(group => group.low.length), [groups])
  const recent = useMemo(() => [...usage].reverse().slice(0, 8), [usage])
  const hour = new Date().getHours(); const firstName = profile?.full_name?.trim().split(/\s+/)[0]
  const dash = (value: number | null) => (loading || value === null ? '—' : String(value))
  return <><PageTitle title={`Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}${firstName ? `, ${firstName}` : ''}.`}/>
    {error && <div className="user-error">Unable to load dashboard data: {error}</div>}
    <section className="stats stats-wide"><Stat label="Chemicals" value={dash(chemicals)} detail="Same chemical from a different make counts separately" tone="teal"/><Stat label="Chemical bottles" value={dash(chemicalBottles.length)} detail={`${places} storage places`} tone="blue"/><Stat label="Commercial solvent cans" value={dash(bottles.filter(b => b.category === 'COMMERCIAL_SOLVENT').length)} detail="One record per can" tone="teal"/><Stat label="NMR solvent bottles" value={dash(bottles.filter(b => b.category === 'NMR_SOLVENT').length)} detail="One record per bottle" tone="blue"/>
      <Stat label="Low-stock items" value={dash(lowAll.length)} detail="All inventories; below threshold or empty" tone="amber"/><Stat label="Solvent usage" value={usageLoading ? '—' : solventTotal} detail={ranges.find(r => r.value === range)?.label ?? ''} tone="teal"/><Stat label="Chemicals to be ordered" value={dash(openOrders)} detail={profile?.role === 'ADMIN' ? 'Open requests' : 'Your open requests'} tone="blue"/><Stat label="Pending order requests" value={dash(pending)} detail="Waiting for Admin approval" tone="red"/></section>
    <div className="range-row"><span className="muted-note">Charts and usage figures cover</span><select className="analytics-select" value={range} onChange={event => setRange(event.target.value as Range)} aria-label="Date range">{ranges.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
    <div className="analytics-grid">
      <ChartPanel title="Usage activity" note="All inventories; units are kept separate" empty={!usageSeries.units.length} loading={usageLoading}><LineChart data={usageSeries.points}><CartesianGrid vertical={false} stroke="#e4ebe7"/><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#83918c', fontSize: 11 }}/><YAxis axisLine={false} tickLine={false} tick={{ fill: '#83918c', fontSize: 11 }}/><Tooltip/><Legend/>{usageSeries.units.map((unit, index) => <Line key={unit} type="monotone" dataKey={unit} name={unit} stroke={colors[index % colors.length]} strokeWidth={2.5} dot={false}/>)}</LineChart></ChartPanel>
      <ChartPanel title="Solvent consumption over time" note="Commercial and NMR solvents" empty={!solventSeries.units.length} loading={usageLoading}><LineChart data={solventSeries.points}><CartesianGrid vertical={false} stroke="#e4ebe7"/><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#83918c', fontSize: 11 }}/><YAxis axisLine={false} tickLine={false} tick={{ fill: '#83918c', fontSize: 11 }}/><Tooltip/><Legend/>{solventSeries.units.map((unit, index) => <Line key={unit} type="monotone" dataKey={unit} name={unit} stroke={colors[index % colors.length]} strokeWidth={2.5} dot={false}/>)}</LineChart></ChartPanel>
      <ChartPanel title="Most frequently used solvents" note="Number of usage entries" empty={!topSolvents.length} loading={usageLoading}><HBar data={topSolvents} dataKey="entries" name="Entries"/></ChartPanel>
      <ChartPanel title="Usage by researcher" note={profile?.role === 'ADMIN' ? 'Number of usage entries' : 'Number of usage entries (everyone)'} empty={!byResearcher.length} loading={usageLoading}><HBar data={byResearcher} dataKey="entries" name="Entries"/></ChartPanel>
      <ChartPanel title="Low-stock items by inventory" note="Bottles and cans below their threshold or empty" empty={!lowAll.length} loading={loading}><HBar data={lowByCategory} dataKey="items" name="Items"/></ChartPanel>
      <ChartPanel title="Order requests by status" note={profile?.role === 'ADMIN' ? 'All requests' : 'Your requests'} empty={!ordersByStatus.length} loading={orders === null}><HBar data={ordersByStatus} dataKey="requests" name="Requests"/></ChartPanel>
      <ChartPanel title="Chemical inventory by make" note="Physical chemical bottles per make" empty={!makeData.length} loading={loading}><HBar data={makeData} dataKey="bottles" name="Bottles"/></ChartPanel>
    </div>
    <div className="analytics-grid overview-lists"><LowStockPanel groups={lowGroups} loading={loading}/><RecentUsagePanel rows={recent} loading={usageLoading} meId={profile?.id}/></div></>
}
function ChartPanel({ title, note, empty, loading, children }: { title: string; note: string; empty: boolean; loading: boolean; children: React.ReactElement }) {
  return <section className="panel chart-panel"><div className="panel-heading"><div><h2>{title}</h2><p>{note}</p></div></div><div className="chart">{loading ? <div className="loading-row">Loading...</div> : empty ? <div className="empty-users">No records in this period.</div> : <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>}</div></section>
}
function HBar({ data, dataKey, name }: { data: Array<Record<string, string | number>>; dataKey: string; name: string }) {
  return <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}><CartesianGrid horizontal={false} stroke="#e4ebe7"/><XAxis type="number" allowDecimals={false} hide/><YAxis dataKey="name" type="category" width={110} axisLine={false} tickLine={false} tick={{ fill: '#64736e', fontSize: 11 }}/><Tooltip/><Bar dataKey={dataKey} name={name} radius={[0, 4, 4, 0]} barSize={15}>{data.map((_, index) => <Cell key={index} fill={colors[index % colors.length]}/>)}</Bar></BarChart>
}
function LowStockPanel({ groups, loading }: { groups: ChemicalGroup[]; loading: boolean }) {
  return <section className="panel table-panel"><div className="panel-heading"><div><h2>Low stock</h2><p>Items (by make) with a bottle below its low-stock level, or empty</p></div><NavLink className="text-button" to="/low-stock">Low Stock <ChevronRight size={14}/></NavLink></div><div className="table-wrap"><table className="compact-table cards"><thead><tr><th>NAME</th><th>INVENTORY</th><th>MAKE</th><th>LOW BOTTLES</th><th>PLACE / TRAY</th></tr></thead><tbody>{loading ? <tr><td colSpan={5}><div className="loading-row">Loading...</div></td></tr> : groups.slice(0, 10).map(group => <tr key={group.key}><td><b>{group.name}</b> <PubChemLink name={group.name} cas={group.cas}/></td><td>{CATEGORY_LABEL[group.category]}</td><td>{group.make ?? '—'}</td><td><b className="low-note">{lowSummary(group)}</b>{group.low.map(b => <small key={b.id} className="cell-note">{b.bottle_id}: {b.quantity <= 0 ? 'Empty' : `${qty(b.quantity, b.unit)} left`}{b.size != null ? ` of ${qty(b.size, b.sizeUnit)}` : ''}</small>)}</td><td>{[...new Set(group.low.map(b => [b.place, b.tray].filter(Boolean).join(' / ')))].join(', ') || '—'}</td></tr>)}{!loading && groups.length === 0 && <tr><td colSpan={5}><div className="empty-users">Nothing is low on stock.</div></td></tr>}</tbody></table></div>{groups.length > 10 && <p className="muted panel-foot">{groups.length - 10} more in Low Stock.</p>}</section>
}
function RecentUsagePanel({ rows, loading, meId }: { rows: Usage[]; loading: boolean; meId?: string }) {
  return <section className="panel table-panel"><div className="panel-heading"><div><h2>Recent usage</h2><p>Latest quantities recorded</p></div><NavLink className="text-button" to="/usage">Usage history <ChevronRight size={14}/></NavLink></div><div className="table-wrap"><table className="compact-table cards"><thead><tr><th>WHEN</th><th>NAME</th><th>USED</th><th>BY</th><th>PURPOSE</th></tr></thead><tbody>{loading ? <tr><td colSpan={5}><div className="loading-row">Loading...</div></td></tr> : rows.map(row => <tr key={row.id}><td>{new Date(row.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td><b>{row.chemical}</b><small className="cell-note">{[row.bottle_code, row.make].filter(Boolean).join(' · ')}</small></td><td><b>{qty(-row.quantity_change, row.quantity_unit)}</b>{row.corrections > 0 && <small className="cell-note corrected-note">Corrected</small>}</td><td>{row.user_id === meId ? 'You' : row.user_name ?? 'Researcher'}</td><td className="wrap-cell">{[row.experiment, row.purpose].filter(Boolean).join(' · ') || '—'}</td></tr>)}{!loading && rows.length === 0 && <tr><td colSpan={5}><div className="empty-users">No usage recorded in this period.</div></td></tr>}</tbody></table></div></section>
}

type BottleAction = { kind: 'use' | 'history' | 'edit' | 'count'; bottle: Bottle }
/** Record usage / history for everyone; edit and stock count for the Admin; add to order when low. */
export function BottleActions({ bottle, onAction, isAdmin }: { bottle: Bottle; onAction: (action: BottleAction) => void; isAdmin: boolean }) {
  const navigate = useNavigate()
  return <div className="user-actions"><button className="table-action usage-action" disabled={!bottle.known || bottle.quantity <= 0} onClick={() => onAction({ kind: 'use', bottle })} aria-label={`Record usage of ${bottle.chemical}`}><ArrowDownToLine size={12}/> Record usage</button>
    <button className="table-action" onClick={() => onAction({ kind: 'history', bottle })} aria-label={`Usage history of ${bottle.bottle_id}`}><History size={12}/> History</button>
    {isAdmin && <button className="table-action" onClick={() => onAction({ kind: 'count', bottle })} aria-label={`Stock count of ${bottle.bottle_id}`}><Scale size={12}/> {bottle.known ? 'Stock count' : 'Enter amount'}</button>}
    {isAdmin && <button className="table-action" onClick={() => onAction({ kind: 'edit', bottle })} aria-label={`Edit ${bottle.bottle_id}`}><PencilLine size={12}/> Edit</button>}
    {isLowOrEmpty(bottle) && <button className="table-action" onClick={() => navigate('/orders', { state: { prefill: orderPrefillFor(bottle) } })}><ShoppingCart size={12}/> Add to order list</button>}</div>
}
export function BottleActionModals({ action, onClose, onDone }: { action: BottleAction | null; onClose: () => void; onDone: (message: string) => void }) {
  const { refresh } = useInventory()
  if (!action) return null
  if (action.kind === 'use') return <RecordUsageModal bottle={action.bottle} onClose={onClose} onRecorded={onDone}/>
  if (action.kind === 'history') return <BottleHistoryModal bottle={action.bottle} onClose={onClose} onChanged={() => void refresh()}/>
  if (action.kind === 'edit') return <EditBottleModal bottle={action.bottle} onClose={onClose} onSaved={onDone}/>
  return <StockCountModal bottle={action.bottle} onClose={onClose} onSaved={onDone}/>
}

type StockFilter = 'all' | 'low' | 'review'
export function InventoryPage() {
  const { profile } = useAuth(); const isAdmin = profile?.role === 'ADMIN'
  const { bottles: everything, loading, error, refresh, groupOf, people } = useInventory()
  const bottles = useMemo(() => everything.filter(b => b.category === 'CHEMICAL'), [everything])
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState<StockFilter>('all')
  const filtered = useMemo(() => bottles.filter(bottle => (filter === 'all' || (filter === 'low' ? isLowOrEmpty(bottle) : !bottle.known)) && matchesChemical(query, bottle.chemical, bottle.cas, bottle.manufacturer, bottle.place, bottle.tray, bottle.bottle_id, bottle.formula)), [bottles, query, filter])
  const paged = usePaged(filtered)
  // e.g. " · 1 of 3 bottles of this chemical (same make)"
  const lowNote = (bottle: Bottle) => { const group = groupOf.get(groupKey(bottle)); return group && group.bottles.length > 1 ? ` · ${group.low.length} of ${group.bottles.length} bottles of this chemical` : '' }
  const [action, setAction] = useState<BottleAction | null>(null); const [notice, setNotice] = useState('')
  const columns = bottleColumns(people)
  return <><PageTitle title="Inventory"/>{error && <div className="user-error">Unable to load inventory: {error}</div>}{notice && <div className="admin-success page-notice">{notice}</div>}
    <section className="panel table-panel"><div className="inventory-toolbar wrap-toolbar"><div className="search"><Search size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by chemical name, CAS No, Bottle ID, make, place or tray..."/></div>
      <select className="analytics-select" value={filter} onChange={event => setFilter(event.target.value as StockFilter)} aria-label="Stock filter"><option value="all">All bottles</option><option value="low">Low stock</option><option value="review">Needs review</option></select>
      <ExportMenu baseName="chemical-inventory" title="Master chemical inventory" columns={columns} scopes={[{ key: 'all', label: 'Export all inventory', rows: bottles }, { key: 'matching', label: 'Export current filtered results', rows: filtered }, { key: 'page', label: 'Export current page', rows: paged.visible }]}/></div>
      <div className="table-wrap"><table className="cards"><thead><tr><th>CHEMICAL NAME</th><th>CAS NO</th><th>MAKE</th><th>BOTTLE SIZE</th><th>AVAILABLE QUANTITY</th><th>PLACE</th><th>TRAY NO.</th><th>LAST USED BY</th><th></th></tr></thead><tbody>{loading && !bottles.length ? <tr><td colSpan={9}><div className="loading-row">Loading inventory...</div></td></tr> : paged.visible.map(bottle => <tr key={bottle.id}><td><div className="chemical"><span className="chem-dot"/><b>{bottle.chemical}</b><PubChemLink name={bottle.chemical} cas={bottle.cas}/></div><small className="cell-note mono">{bottle.bottle_id}</small></td><td className="mono">{bottle.cas ?? '—'}</td><td>{bottle.manufacturer ?? '—'}</td><td>{qty(bottle.size, bottle.sizeUnit)}</td><td><b>{remainingText(bottle)}</b>{bottle.known && bottle.quantity <= 0 ? <small className="cell-note low-note">Empty</small> : isLowQuantity(bottle) ? <small className="cell-note low-note">Low stock{lowNote(bottle)}</small> : !bottle.known ? <small className="cell-note pending-note">Needs review</small> : null}</td><td><span className="location"><MapPin size={13}/>{bottle.place ?? '—'}</span></td><td>{bottle.tray ?? '—'}</td><td><LastUsed bottle={bottle} compact/></td><td><BottleActions bottle={bottle} isAdmin={isAdmin} onAction={next => { setNotice(''); setAction(next) }}/></td></tr>)}{!loading && filtered.length === 0 && <tr><td colSpan={9}><div className="empty-users">{bottles.length ? 'No bottles match the search or filter.' : 'No Supabase inventory records found.'}</div></td></tr>}</tbody></table></div>
      <Pager {...paged} total={filtered.length} noun="bottles"/></section>
    <BottleActionModals action={action} onClose={() => setAction(null)} onDone={message => { setAction(null); setNotice(message); void refresh() }}/></>
}

export function ChemicalsPage() {
  const { profile } = useAuth(); const isAdmin = profile?.role === 'ADMIN'
  const { groups: allGroups, loading, error, refresh } = useInventory()
  const groups = useMemo(() => allGroups.filter(group => group.category === 'CHEMICAL'), [allGroups])
  const [query, setQuery] = useState(''); const [open, setOpen] = useState<string | null>(null); const [onlyLow, setOnlyLow] = useState(false)
  const [action, setAction] = useState<BottleAction | null>(null); const [notice, setNotice] = useState('')
  const filtered = useMemo(() => groups.filter(group => (!onlyLow || group.low.length > 0) && matchesChemical(query, group.name, group.cas, group.make, ...group.bottles.map(b => b.bottle_id))), [groups, query, onlyLow])
  const paged = usePaged(filtered)
  const columns: ExportColumn<ChemicalGroup>[] = [{ header: 'Chemical name', value: g => g.name }, { header: 'CAS No', value: g => g.cas }, { header: 'Make', value: g => g.make }, { header: 'Bottles', value: g => g.bottles.length }, { header: 'Total available', value: g => groupTotal(g.bottles).label }, { header: 'Low or empty bottles', value: g => g.low.length }, { header: 'Stock', value: g => (g.low.length ? lowSummary(g) : g.bottles.length ? 'OK' : 'No bottles') }]
  return <><PageTitle title="Chemicals"/>{error && <div className="user-error">Unable to load chemicals: {error}</div>}{notice && <div className="admin-success page-notice">{notice}</div>}<section className="panel table-panel"><div className="inventory-toolbar wrap-toolbar"><div className="search"><Search size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by chemical name, CAS No (e.g. 532-27-4), make or Bottle ID..."/></div><label className="only-low"><input type="checkbox" checked={onlyLow} onChange={event => setOnlyLow(event.target.checked)}/> Only low stock</label>
    <ExportMenu baseName="chemicals" title="Chemicals (by make)" columns={columns} scopes={[{ key: 'matching', label: 'All matching results', rows: filtered }, { key: 'page', label: 'Current page', rows: paged.visible }, { key: 'all', label: 'All chemicals', rows: groups }]}/><span className="muted">the same chemical from a different make is listed separately</span></div><div className="table-wrap"><table className="cards"><thead><tr><th>CHEMICAL NAME</th><th>CAS NO</th><th>MAKE</th><th>BOTTLES</th><th>TOTAL AVAILABLE</th><th>STOCK</th><th></th></tr></thead><tbody>{loading && !groups.length ? <tr><td colSpan={7}><div className="loading-row">Loading chemicals...</div></td></tr> : paged.visible.map(group => { const expanded = open === group.key; return <Fragment key={group.key}><tr className="clickable-row" onClick={() => setOpen(expanded ? null : group.key)}><td><div className="chemical"><span className="chem-dot"/><b>{group.name}</b><PubChemLink name={group.name} cas={group.cas}/></div></td><td className="mono">{group.cas ?? '—'}</td><td>{group.make ?? '—'}</td><td><b>{group.bottles.length}</b></td><td>{groupTotal(group.bottles).label}</td><td>{group.low.length ? <span className="low-badge">{lowSummary(group)}</span> : group.bottles.length ? <span className="ok-badge">OK</span> : '—'}</td><td className="chev-cell">{expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</td></tr>{expanded && <tr className="detail-row"><td colSpan={7}>{group.bottles.length ? <table className="nested-table cards"><thead><tr><th>BOTTLE</th><th>BOTTLE SIZE</th><th>AVAILABLE QUANTITY</th><th>% OF INITIAL</th><th>PLACE / TRAY</th><th>STATUS</th><th>LAST USED BY</th><th>ACTIONS</th></tr></thead><tbody>{group.bottles.map((row, index) => { const pct = percentLeft(row); const low = group.low.includes(row); return <tr key={row.id} className={low ? 'low-row' : ''}><td>Bottle {index + 1} of {group.bottles.length}<small className="cell-note mono">{row.bottle_id}</small></td><td>{qty(row.size, row.sizeUnit)}</td><td><b>{remainingText(row)}</b>{low && <small className="cell-note low-note">{row.quantity <= 0 ? 'Empty' : 'Low stock'}</small>}</td><td>{pct === null ? '—' : `${pct.toFixed(1)}%`}</td><td>{[row.place, row.tray].filter(Boolean).join(' / ') || '—'}</td><td><StatusBadge status={bottleStatus(row)}/></td><td><LastUsed bottle={row} compact/></td><td><BottleActions bottle={row} isAdmin={isAdmin} onAction={next => { setNotice(''); setAction(next) }}/></td></tr> })}</tbody></table> : <div className="empty-users">No physical bottles recorded for this chemical.</div>}</td></tr>}</Fragment> })}{!loading && filtered.length === 0 && <tr><td colSpan={7}><div className="empty-users">{onlyLow ? 'No low-stock chemicals.' : 'No Supabase chemical records found.'}</div></td></tr>}</tbody></table></div><Pager {...paged} total={filtered.length} noun="chemicals"/></section>
    <BottleActionModals action={action} onClose={() => setAction(null)} onDone={message => { setAction(null); setNotice(message); void refresh() }}/></>
}

function Stat({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) { return <div className="stat"><div className={`stat-icon ${tone}`}><Boxes size={17}/></div><div><strong>{value}</strong><span>{label}</span><small>{detail}</small></div></div> }
