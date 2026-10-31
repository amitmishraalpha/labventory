import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Ban, Check, ChevronDown, ChevronRight, PackageCheck, PencilLine, Plus, Search, ShoppingCart, Truck, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { explainError } from '../lib/errors'
import { useAuth } from '../auth/AuthProvider'
import { CATEGORY_LABEL, fetchAll, round, useInventory, type Category } from '../data/InventoryProvider'
import { ExportMenu, Pager, StatusBadge, usePaged } from '../components/TableTools'
import { fmtDate, fmtDateTime, type ExportColumn } from '../lib/exporter'
import { matchesChemical } from '../lib/search'

export type OrderRequest = {
  id: string; chemical_id: string | null; source_bottle_id: string | null; chemical_name: string; cas_number: string | null; molecular_formula: string | null; category: Category
  requested_quantity: number; quantity_unit: string; preferred_pack_size: string | null; preferred_supplier: string | null; reason: string | null; experiment: string | null; priority: string; notes: string | null
  status: string; requested_by: string; requested_at: string; supplier: string | null; purchase_order_number: string | null; order_date: string | null; expected_delivery: string | null; unit_price: number | null
  admin_notes: string | null; decision_note: string | null; quantity_received: number; updated_at: string
}
type HistoryRow = { id: string; request_id: string; from_status: string | null; to_status: string; changed_by: string; note: string | null; details: Record<string, any>; created_at: string }
export const ORDER_STATUSES = ['Requested', 'Pending Approval', 'Approved', 'Ordered', 'Partially Received', 'Received', 'Rejected', 'Cancelled']
export const OPEN = ['Requested', 'Pending Approval', 'Approved', 'Ordered', 'Partially Received']
const UNITS = ['mg', 'g', 'kg', 'µL', 'mL', 'L']
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent']
const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => <label>{label}{hint && <small>{hint}</small>}{children}</label>

function useSubmit() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const inFlight = useRef(false)
  const run = async (action: () => PromiseLike<{ error: unknown; data?: unknown }>, fallback: string) => {
    if (inFlight.current) return null
    inFlight.current = true; setBusy(true); setError('')
    const { error: rpcError, data } = await action()
    inFlight.current = false; setBusy(false)
    if (rpcError) { setError(await explainError(rpcError, fallback)); return null }
    return { data }
  }
  return { busy, error, setError, run }
}

type FormState = Record<'chemical_name' | 'cas_number' | 'molecular_formula' | 'category' | 'requested_quantity' | 'quantity_unit' | 'preferred_pack_size' | 'preferred_supplier' | 'reason' | 'experiment' | 'priority' | 'notes', string>
const blankForm: FormState = { chemical_name: '', cas_number: '', molecular_formula: '', category: 'CHEMICAL', requested_quantity: '', quantity_unit: 'g', preferred_pack_size: '', preferred_supplier: '', reason: '', experiment: '', priority: 'Normal', notes: '' }

/** New request, or editing an open one (requester while Requested / Pending Approval; Admin while open). */
function RequestForm({ existing, prefill, onClose, onSaved }: { existing?: OrderRequest; prefill?: Partial<FormState> & { chemical_id?: string; source_bottle_id?: string }; onClose: () => void; onSaved: (message: string) => void }) {
  const start: FormState = existing ? { chemical_name: existing.chemical_name, cas_number: existing.cas_number ?? '', molecular_formula: existing.molecular_formula ?? '', category: existing.category, requested_quantity: String(existing.requested_quantity), quantity_unit: existing.quantity_unit, preferred_pack_size: existing.preferred_pack_size ?? '', preferred_supplier: existing.preferred_supplier ?? '', reason: existing.reason ?? '', experiment: existing.experiment ?? '', priority: existing.priority, notes: existing.notes ?? '' }
    : { ...blankForm, ...Object.fromEntries(Object.entries(prefill ?? {}).filter(([key, value]) => key in blankForm && value)) as Partial<FormState> }
  if (!UNITS.includes(start.quantity_unit)) start.quantity_unit = 'g'
  const [form, setForm] = useState(start); const [duplicate, setDuplicate] = useState(''); const { busy, error, setError, run } = useSubmit()
  const set = (key: keyof FormState) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }))
  const submit = async (event: FormEvent | null, allowDuplicate = false) => {
    event?.preventDefault(); setDuplicate('')
    if (!form.chemical_name.trim()) { setError('Enter the chemical name.'); return }
    if (!(Number(form.requested_quantity) > 0)) { setError('Enter the quantity needed.'); return }
    const trimmed = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()]))
    if (existing) {
      const changes = Object.fromEntries(Object.entries(trimmed).filter(([key, value]) => key !== 'category' && value !== (start[key as keyof FormState] ?? '').trim()))
      if (!Object.keys(changes).length) { setError('Nothing has changed.'); return }
      if (await run(() => supabase.rpc('update_order_request', { p_id: existing.id, p_changes: changes }), 'The request could not be saved.')) onSaved(`Saved changes to the request for ${form.chemical_name.trim()}.`)
      return
    }
    const p = { ...trimmed, chemical_id: prefill?.chemical_id ?? '', source_bottle_id: prefill?.source_bottle_id ?? '' }
    const { error: rpcError } = await supabase.rpc('submit_order_request', { p, p_allow_duplicate: allowDuplicate })
    if (rpcError) { const message = await explainError(rpcError, 'The request could not be submitted.'); if (/already on the order list/.test(message)) { setDuplicate(message); return } setError(message); return }
    onSaved(`${form.chemical_name.trim()} was added to the order list. The Admin will review it.`)
  }
  return <div className="modal-backdrop" onClick={onClose}><form className="modal usage-modal wide-form" onClick={event => event.stopPropagation()} onSubmit={event => void submit(event)}>
    <div className="modal-head"><div><span className="eyebrow">{existing ? 'EDIT REQUEST' : 'ADD CHEMICAL TO ORDER'}</span><h2>{existing ? existing.chemical_name : 'Chemical to be ordered'}</h2><p>A request is not stock: nothing is added to the inventory until it is received.</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <div className="form-grid">
      <Field label="Chemical name"><input required value={form.chemical_name} onChange={set('chemical_name')}/></Field>
      <Field label="CAS No" hint="If known"><input value={form.cas_number} onChange={set('cas_number')} placeholder="e.g. 865-49-6"/></Field>
      <Field label="Molecular formula" hint="If known"><input value={form.molecular_formula} onChange={set('molecular_formula')}/></Field>
      {!existing && <Field label="Inventory"><select value={form.category} onChange={set('category')}>{(Object.keys(CATEGORY_LABEL) as Category[]).map(value => <option key={value} value={value}>{CATEGORY_LABEL[value]}</option>)}</select></Field>}
      <Field label="Quantity needed"><div className="usage-amount"><input type="number" min="0" step="any" required value={form.requested_quantity} onChange={set('requested_quantity')}/><select value={form.quantity_unit} onChange={set('quantity_unit')} aria-label="Unit">{UNITS.map(unit => <option key={unit}>{unit}</option>)}</select></div></Field>
      <Field label="Preferred pack size" hint="e.g. 100 mL"><input value={form.preferred_pack_size} onChange={set('preferred_pack_size')}/></Field>
      <Field label="Manufacturer / supplier preference"><input value={form.preferred_supplier} onChange={set('preferred_supplier')}/></Field>
      <Field label="Priority"><select value={form.priority} onChange={set('priority')}>{PRIORITIES.map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Experiment / project"><input value={form.experiment} onChange={set('experiment')}/></Field>
    </div>
    <Field label="Reason for request"><input value={form.reason} onChange={set('reason')} placeholder="e.g. Low stock, new project"/></Field>
    <Field label="Notes"><textarea rows={2} value={form.notes} onChange={set('notes')}/></Field>
    {duplicate && <div className="info-note warn">{duplicate}<div className="modal-actions inline"><button type="button" className="secondary" onClick={onClose}>Don't add</button><button type="button" className="primary" disabled={busy} onClick={() => void submit(null, true)}>Add anyway</button></div></div>}
    {error && <div className="user-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || Boolean(duplicate)}>{busy ? 'Saving...' : existing ? 'Save changes' : 'Submit request'}</button></div>
  </form></div>
}

/** Approve / reject / pending / cancel / mark received, with a confirmation and an optional (or required) note. */
function StatusModal({ request, to, onClose, onSaved }: { request: OrderRequest; to: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [note, setNote] = useState(''); const { busy, error, setError, run } = useSubmit()
  const needsNote = to === 'Rejected'
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (needsNote && note.trim().length < 3) { setError('Give a reason for rejecting.'); return }
    if (await run(() => supabase.rpc('update_order_request', { p_id: request.id, p_status: to, p_note: note.trim() || null }), 'The status could not be changed.')) onSaved(`${request.chemical_name}: ${to.toLowerCase()}.`)
  }
  const verb: Record<string, string> = { Approved: 'Approve', Rejected: 'Reject', 'Pending Approval': 'Mark pending approval', Cancelled: 'Cancel request', Received: 'Mark fully received' }
  return <div className="modal-backdrop" onClick={onClose}><form className="modal usage-modal" onClick={event => event.stopPropagation()} onSubmit={submit}>
    <div className="modal-head"><div><span className="eyebrow">CONFIRM</span><h2>{verb[to] ?? to}: {request.chemical_name}</h2><p>{round(request.requested_quantity)} {request.quantity_unit} · requested {fmtDate(request.requested_at)} · now {request.status}</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <Field label={needsNote ? 'Reason' : 'Note'} hint={needsNote ? 'Required; the requester can see it' : 'Optional'}><textarea rows={2} value={note} onChange={event => setNote(event.target.value)}/></Field>
    {error && <div className="user-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Back</button><button className={to === 'Rejected' || to === 'Cancelled' ? 'primary danger-button' : 'primary'} disabled={busy}>{busy ? 'Saving...' : verb[to] ?? to}</button></div>
  </form></div>
}

function OrderedModal({ request, onClose, onSaved }: { request: OrderRequest; onClose: () => void; onSaved: (message: string) => void }) {
  const [form, setForm] = useState({ supplier: request.supplier ?? request.preferred_supplier ?? '', purchase_order_number: request.purchase_order_number ?? '', order_date: request.order_date ?? new Date().toISOString().slice(0, 10), expected_delivery: request.expected_delivery ?? '', unit_price: request.unit_price == null ? '' : String(request.unit_price), admin_notes: request.admin_notes ?? '' })
  const { busy, error, run } = useSubmit()
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const changes = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()]))
    if (await run(() => supabase.rpc('update_order_request', { p_id: request.id, p_status: request.status === 'Approved' ? 'Ordered' : null, p_changes: changes }), 'The order details could not be saved.')) onSaved(`${request.chemical_name}: ${request.status === 'Approved' ? 'marked as ordered' : 'order details saved'}.`)
  }
  return <div className="modal-backdrop" onClick={onClose}><form className="modal usage-modal wide-form" onClick={event => event.stopPropagation()} onSubmit={submit}>
    <div className="modal-head"><div><span className="eyebrow">{request.status === 'Approved' ? 'MARK AS ORDERED' : 'ORDER DETAILS'}</span><h2>{request.chemical_name}</h2><p>{round(request.requested_quantity)} {request.quantity_unit}{request.preferred_pack_size ? ` · pack ${request.preferred_pack_size}` : ''}</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <div className="form-grid"><Field label="Supplier"><input value={form.supplier} onChange={set('supplier')}/></Field><Field label="Purchase order No."><input value={form.purchase_order_number} onChange={set('purchase_order_number')}/></Field>
      <Field label="Order date"><input type="date" value={form.order_date} onChange={set('order_date')}/></Field><Field label="Expected delivery"><input type="date" value={form.expected_delivery} onChange={set('expected_delivery')}/></Field>
      <Field label="Unit price" hint="Optional"><input type="number" min="0" step="any" value={form.unit_price} onChange={set('unit_price')}/></Field></div>
    <Field label="Admin notes"><textarea rows={2} value={form.admin_notes} onChange={set('admin_notes')}/></Field>
    {error && <div className="user-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving...' : request.status === 'Approved' ? 'Mark as ordered' : 'Save'}</button></div>
  </form></div>
}

function ReceiveModal({ request, onClose, onSaved }: { request: OrderRequest; onClose: () => void; onSaved: (message: string) => void }) {
  const { chemicals } = useInventory()
  // Identity is verified by the Admin: offer the request's own chemical, or chemicals with the same CAS / exact name.
  const candidates = useMemo(() => chemicals.filter(c => c.id === request.chemical_id || (request.cas_number && c.cas === request.cas_number) || c.name.trim().toLowerCase() === request.chemical_name.trim().toLowerCase()).slice(0, 5), [chemicals, request])
  const [chemicalId, setChemicalId] = useState(candidates[0]?.id ?? '')
  const [form, setForm] = useState({ bottle_id: '', quantity: '', unit: request.quantity_unit, bottle_size: '', manufacturer: request.preferred_supplier ?? '', supplier: request.supplier ?? '', batch_lot_number: '', purchase_date: request.order_date ?? '', expiry_date: '', place: '', tray: '', note: '' })
  const [completion, setCompletion] = useState<'auto' | 'complete' | 'partial'>('auto'); const [confirming, setConfirming] = useState(false); const { busy, error, setError, run } = useSubmit()
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }))
  const check = (event: FormEvent) => { event.preventDefault(); if (!form.bottle_id.trim()) { setError('Enter the new Bottle ID.'); return } if (!(Number(form.quantity) > 0)) { setError('Enter the quantity received.'); return } setError(''); setConfirming(true) }
  const save = async () => {
    const item = { ...Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()])), bottle_size: form.bottle_size.trim() || form.quantity.trim(), bottle_size_unit: form.unit, category: request.category, chemical_id: chemicalId }
    const result = await run(() => supabase.rpc('receive_order', { p_request_id: request.id, p_item: item, p_complete: completion === 'auto' ? null : completion === 'complete' }), 'The stock could not be received.')
    if (result) onSaved(`Received ${form.quantity} ${form.unit} of ${request.chemical_name} as bottle ${form.bottle_id.trim()} (now ${(result.data as { status: string }).status}). It is in the inventory now.`)
    else setConfirming(false)
  }
  return <div className="modal-backdrop" onClick={onClose}><form className="modal usage-modal wide-form" onClick={event => event.stopPropagation()} onSubmit={check}>
    <div className="modal-head"><div><span className="eyebrow">RECEIVE STOCK</span><h2>{request.chemical_name}</h2><p>Ordered {round(request.requested_quantity)} {request.quantity_unit}; received so far {round(request.quantity_received)} {request.quantity_unit}. Each physical bottle is received separately.</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    {confirming ? <div className="review-box"><h3>Confirm receipt</h3><dl><dt>New bottle</dt><dd><b>{form.bottle_id}</b> · {form.quantity} {form.unit} · {CATEGORY_LABEL[request.category]}</dd><dt>Chemical record</dt><dd>{chemicalId ? `Existing: ${candidates.find(c => c.id === chemicalId)?.name}` : 'New chemical record'}</dd><dt>Location</dt><dd>{[form.place, form.tray].filter(Boolean).join(' / ') || '—'}</dd></dl><p className="muted-note">This creates the bottle and a stock-in transaction in one step.</p></div> : <>
      <Field label="Chemical record" hint="Choose an existing record only if it is the same chemical"><select value={chemicalId} onChange={event => setChemicalId(event.target.value)}>{candidates.map(c => <option key={c.id} value={c.id}>Existing: {c.name}{c.cas ? ` (${c.cas})` : ''}</option>)}<option value="">New chemical record: {request.chemical_name}</option></select></Field>
      <div className="form-grid">
        <Field label="New Bottle ID" hint="Unique"><input required value={form.bottle_id} onChange={set('bottle_id')}/></Field>
        <Field label="Quantity received"><div className="usage-amount"><input type="number" min="0" step="any" required value={form.quantity} onChange={set('quantity')}/><select value={form.unit} onChange={set('unit')} aria-label="Unit">{UNITS.map(unit => <option key={unit}>{unit}</option>)}</select></div></Field>
        <Field label={`Actual pack size (${form.unit})`} hint="Empty = same as quantity"><input type="number" min="0" step="any" value={form.bottle_size} onChange={set('bottle_size')}/></Field>
        <Field label="Manufacturer"><input value={form.manufacturer} onChange={set('manufacturer')}/></Field>
        <Field label="Supplier"><input value={form.supplier} onChange={set('supplier')}/></Field>
        <Field label="Batch / lot No."><input value={form.batch_lot_number} onChange={set('batch_lot_number')}/></Field>
        <Field label="Purchase date"><input type="date" value={form.purchase_date} onChange={set('purchase_date')}/></Field>
        <Field label="Expiry date" hint="If any"><input type="date" value={form.expiry_date} onChange={set('expiry_date')}/></Field>
        <Field label="Place"><input value={form.place} onChange={set('place')}/></Field>
        <Field label="Tray No."><input value={form.tray} onChange={set('tray')}/></Field>
        <Field label="Order status after this"><select value={completion} onChange={event => setCompletion(event.target.value as typeof completion)}><option value="auto">Decide from quantities</option><option value="complete">Order complete (Received)</option><option value="partial">More to come (Partially Received)</option></select></Field>
      </div></>}
    {error && <div className="user-error">{error}</div>}
    <div className="modal-actions">{confirming ? <><button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Back</button><button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Receive into inventory'}</button></> : <><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary">Review</button></>}</div>
  </form></div>
}

type Action = { kind: 'new' } | { kind: 'edit' | 'ordered' | 'receive'; request: OrderRequest } | { kind: 'status'; request: OrderRequest; to: string }
export default function OrdersPage() {
  const { profile } = useAuth(); const isAdmin = profile?.role === 'ADMIN'; const { people, refresh: refreshInventory } = useInventory()
  const location = useLocation(); const navigate = useNavigate()
  const prefill = (location.state as { prefill?: Record<string, string> } | null)?.prefill
  const [rows, setRows] = useState<OrderRequest[] | null>(null); const [history, setHistory] = useState<Map<string, HistoryRow[]>>(new Map()); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
  const [query, setQuery] = useState(''); const [status, setStatus] = useState('open'); const [priority, setPriority] = useState(''); const [open, setOpen] = useState<string | null>(null)
  const [action, setAction] = useState<Action | null>(prefill ? { kind: 'new' } : null)
  const load = useCallback(async () => {
    try {
      const [requests, events] = await Promise.all([
        fetchAll<OrderRequest>((from, to) => supabase.from('chemical_order_requests').select('*').order('requested_at', { ascending: false }).range(from, to)),
        fetchAll<HistoryRow>((from, to) => supabase.from('order_request_history').select('*').order('created_at').range(from, to)),
      ])
      setRows(requests.map(r => ({ ...r, requested_quantity: Number(r.requested_quantity), quantity_received: Number(r.quantity_received) })))
      const map = new Map<string, HistoryRow[]>(); for (const event of events) map.set(event.request_id, [...(map.get(event.request_id) ?? []), event]); setHistory(map)
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load order requests.') }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { const channel = supabase.channel('orders-sync').on('postgres_changes', { event: '*', schema: 'public', table: 'chemical_order_requests' }, () => void load()).subscribe(); return () => { void supabase.removeChannel(channel) } }, [load])
  const filtered = useMemo(() => (rows ?? []).filter(r => (status === 'all' || (status === 'open' ? OPEN.includes(r.status) : r.status === status)) && (!priority || r.priority === priority)
    && matchesChemical(query, r.chemical_name, r.cas_number, r.preferred_supplier, r.supplier, r.experiment, r.reason, people.get(r.requested_by))), [rows, status, priority, query, people])
  const paged = usePaged(filtered)
  const done = (message: string) => { setAction(null); setNotice(message); if (prefill) navigate('/orders', { replace: true, state: null }); void load(); void refreshInventory() }
  const close = () => { setAction(null); if (prefill) navigate('/orders', { replace: true, state: null }) }
  const counts = useMemo(() => Object.fromEntries(ORDER_STATUSES.map(s => [s, (rows ?? []).filter(r => r.status === s).length])), [rows])
  const columns: ExportColumn<OrderRequest>[] = [
    { header: 'Chemical name', value: r => r.chemical_name }, { header: 'CAS No', value: r => r.cas_number }, { header: 'Molecular formula', value: r => r.molecular_formula }, { header: 'Inventory', value: r => CATEGORY_LABEL[r.category] },
    { header: 'Requested quantity', value: r => round(r.requested_quantity) }, { header: 'Unit', value: r => r.quantity_unit }, { header: 'Preferred pack size', value: r => r.preferred_pack_size }, { header: 'Supplier preference', value: r => r.preferred_supplier },
    { header: 'Reason', value: r => r.reason }, { header: 'Experiment / project', value: r => r.experiment }, { header: 'Priority', value: r => r.priority }, { header: 'Status', value: r => r.status },
    { header: 'Requested by', value: r => people.get(r.requested_by) ?? '' }, { header: 'Requested at', value: r => fmtDateTime(r.requested_at) }, { header: 'Supplier', value: r => r.supplier }, { header: 'PO No.', value: r => r.purchase_order_number },
    { header: 'Order date', value: r => r.order_date }, { header: 'Expected delivery', value: r => r.expected_delivery }, { header: 'Received so far', value: r => round(r.quantity_received) }, { header: 'Decision note', value: r => r.decision_note }, { header: 'Notes', value: r => r.notes },
  ]
  const btn = (label: string, icon: ReactNode, onClick: () => void, tone = '') => <button key={label} className={`table-action ${tone}`} onClick={onClick}>{icon} {label}</button>
  const actionsFor = (r: OrderRequest) => {
    const list: ReactNode[] = []
    const mine = r.requested_by === profile?.id
    if (isAdmin) {
      if (r.status === 'Requested') list.push(btn('Pending', <ChevronRight size={12}/>, () => setAction({ kind: 'status', request: r, to: 'Pending Approval' })))
      if (['Requested', 'Pending Approval'].includes(r.status)) { list.push(btn('Approve', <Check size={12}/>, () => setAction({ kind: 'status', request: r, to: 'Approved' }))); list.push(btn('Reject', <Ban size={12}/>, () => setAction({ kind: 'status', request: r, to: 'Rejected' }), 'danger')) }
      if (r.status === 'Approved') list.push(btn('Mark ordered', <Truck size={12}/>, () => setAction({ kind: 'ordered', request: r })))
      if (['Ordered', 'Partially Received'].includes(r.status)) list.push(btn('Order details', <Truck size={12}/>, () => setAction({ kind: 'ordered', request: r })))
      if (['Approved', 'Ordered', 'Partially Received'].includes(r.status)) list.push(btn('Receive', <PackageCheck size={12}/>, () => setAction({ kind: 'receive', request: r })))
      if (r.status === 'Partially Received') list.push(btn('Mark complete', <Check size={12}/>, () => setAction({ kind: 'status', request: r, to: 'Received' })))
    }
    if (OPEN.includes(r.status) && (isAdmin || (mine && ['Requested', 'Pending Approval'].includes(r.status)))) list.push(btn('Edit', <PencilLine size={12}/>, () => setAction({ kind: 'edit', request: r })))
    if ((isAdmin && OPEN.includes(r.status)) || (mine && ['Requested', 'Pending Approval'].includes(r.status))) list.push(btn('Cancel', <X size={12}/>, () => setAction({ kind: 'status', request: r, to: 'Cancelled' }), 'danger'))
    return list
  }
  return <><div className="title-row"><div><p className="eyebrow">PROCUREMENT</p><h1>Chemicals to be ordered</h1><p className="subtitle">{isAdmin ? 'All requests from the lab. Requests are not stock; receiving an order adds the bottle to the inventory.' : 'Request chemicals that need buying. You can see the status of your own requests here.'}</p></div><button className="primary" onClick={() => setAction({ kind: 'new' })}><Plus size={16}/> Add chemical to order</button></div>
    {notice && <div className="admin-success page-notice">{notice}</div>}{error && <div className="user-error">{error}</div>}
    <section className="order-summary">{['Requested', 'Pending Approval', 'Approved', 'Ordered', 'Partially Received'].map(s => <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(status === s ? 'open' : s)}><strong>{counts[s] ?? 0}</strong><span>{s}</span></button>)}</section>
    <section className="panel table-panel"><div className="inventory-toolbar wrap-toolbar"><div className="search"><Search size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search chemical, CAS, supplier, project or requester..."/></div>
      <select className="analytics-select" value={status} onChange={event => setStatus(event.target.value)} aria-label="Status"><option value="open">Open requests</option><option value="all">All requests</option>{ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select>
      <select className="analytics-select" value={priority} onChange={event => setPriority(event.target.value)} aria-label="Priority"><option value="">Any priority</option>{PRIORITIES.map(p => <option key={p}>{p}</option>)}</select>
      <ExportMenu baseName="chemicals-to-order" title="Chemicals to be ordered" columns={columns} scopes={[{ key: 'matching', label: 'All matching requests', rows: filtered }, { key: 'page', label: 'Current page', rows: paged.visible }, { key: 'all', label: 'All requests', rows: rows ?? [] }]}/></div>
      <div className="table-wrap"><table className="cards"><thead><tr><th>CHEMICAL</th><th>QUANTITY</th><th>PRIORITY</th><th>REQUESTED BY</th><th>STATUS</th><th>ORDER</th><th>ACTIONS</th><th></th></tr></thead><tbody>
        {rows === null ? <tr><td colSpan={8}><div className="loading-row">Loading requests...</div></td></tr> : paged.visible.map(r => { const expanded = open === r.id; const events = history.get(r.id) ?? []; return <Fragment key={r.id}><tr>
          <td><b>{r.chemical_name}</b><small className="cell-note">{[r.cas_number, CATEGORY_LABEL[r.category], r.preferred_pack_size && `pack ${r.preferred_pack_size}`].filter(Boolean).join(' · ')}</small>{r.reason && <small className="cell-note">{r.reason}</small>}</td>
          <td><b>{round(r.requested_quantity)} {r.quantity_unit}</b>{r.quantity_received > 0 && <small className="cell-note">received {round(r.quantity_received)} {r.quantity_unit}</small>}</td>
          <td><span className={`priority ${r.priority.toLowerCase()}`}>{r.priority}</span></td>
          <td>{r.requested_by === profile?.id ? 'You' : people.get(r.requested_by) ?? 'Unknown user'}<small className="cell-note">{fmtDate(r.requested_at)}</small></td>
          <td><StatusBadge status={r.status}/>{r.decision_note && <small className="cell-note">{r.decision_note}</small>}</td>
          <td className="wrap-cell">{r.supplier || r.purchase_order_number || r.expected_delivery ? <>{r.supplier ?? '—'}{r.purchase_order_number && <small className="cell-note">PO {r.purchase_order_number}</small>}{r.expected_delivery && <small className="cell-note">Expected {fmtDate(r.expected_delivery)}</small>}</> : <span className="muted">—</span>}</td>
          <td><div className="user-actions">{actionsFor(r)}</div></td>
          <td className="chev-cell"><button className="table-action" onClick={() => setOpen(expanded ? null : r.id)} aria-label="Status history" aria-expanded={expanded}>{expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button></td></tr>
          {expanded && <tr className="detail-row"><td colSpan={8}><div className="correction-list">{r.experiment && <div><b>Experiment / project</b><span>{r.experiment}</span></div>}{r.notes && <div><b>Notes</b><span>{r.notes}</span></div>}{isAdmin && r.admin_notes && <div><b>Admin notes</b><span>{r.admin_notes}</span></div>}
            {events.map(e => <div key={e.id}><b>{fmtDateTime(e.created_at)} · {people.get(e.changed_by) ?? 'Unknown user'}</b><span>{e.from_status ? `${e.from_status} → ${e.to_status}` : `Submitted (${e.to_status})`}{e.details?.bottle_code ? ` · received bottle ${e.details.bottle_code}: ${e.details.quantity} ${e.details.unit}` : ''}{e.details?.changes ? ` · edited ${Object.keys(e.details.changes).join(', ')}` : ''}</span>{e.note && <small>{e.note}</small>}</div>)}</div></td></tr>}</Fragment> })}
        {rows !== null && !filtered.length && <tr><td colSpan={8}><div className="empty-users">{rows.length ? 'No requests match the filters.' : <><ShoppingCart size={14}/> No chemicals on the order list yet.</>}</div></td></tr>}
      </tbody></table></div><Pager {...paged} total={filtered.length} noun="requests"/></section>
    {action?.kind === 'new' && <RequestForm prefill={prefill} onClose={close} onSaved={done}/>}
    {action?.kind === 'edit' && <RequestForm existing={action.request} onClose={close} onSaved={done}/>}
    {action?.kind === 'status' && <StatusModal request={action.request} to={action.to} onClose={close} onSaved={done}/>}
    {action?.kind === 'ordered' && <OrderedModal request={action.request} onClose={close} onSaved={done}/>}
    {action?.kind === 'receive' && <ReceiveModal request={action.request} onClose={close} onSaved={done}/>}
  </>
}
