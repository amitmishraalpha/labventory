import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { explainError } from '../lib/errors'
import { CATEGORY_LABEL, qty, type Bottle, type Category } from '../data/InventoryProvider'
import { unitsLike } from '../lib/units'

const ALL_UNITS = ['mg', 'g', 'kg', 'µL', 'mL', 'L']
const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => <label>{label}{hint && <small>{hint}</small>}{children}</label>

function useSubmit() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const inFlight = useRef(false)
  const run = async (action: () => Promise<{ error: unknown }>, fallback: string) => {
    if (inFlight.current) return false
    inFlight.current = true; setBusy(true); setError('')
    const { error: rpcError } = await action()
    inFlight.current = false; setBusy(false)
    if (rpcError) { setError(await explainError(rpcError, fallback)); return false }
    return true
  }
  return { busy, error, setError, run }
}

/** Admin: correct descriptive details. Quantities are never edited here (see StockCountModal). */
export function EditBottleModal({ bottle, onClose, onSaved }: { bottle: Bottle; onClose: () => void; onSaved: (message: string) => void }) {
  const initial = {
    chemical_name: bottle.chemical, cas_number: bottle.cas ?? '', molecular_formula: bottle.formula ?? '', bottle_id: bottle.bottle_id, manufacturer: bottle.manufacturer ?? '', place: bottle.place ?? '', tray: bottle.tray ?? '',
    bottle_size: bottle.size == null ? '' : String(bottle.size), bottle_size_unit: bottle.sizeUnit ?? bottle.unit ?? '', initial_quantity: bottle.initial == null ? '' : String(bottle.initial),
    low_stock_threshold: bottle.threshold ? String(bottle.threshold) : '', low_stock_threshold_unit: bottle.thresholdUnit ?? bottle.unit ?? '', notes: bottle.notes ?? '', expiry_date: bottle.expiry ?? '', batch_lot_number: bottle.batch ?? '', category: bottle.category as string,
  }
  const [form, setForm] = useState(initial); const [reason, setReason] = useState(''); const { busy, error, setError, run } = useSubmit()
  const set = (key: keyof typeof initial) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }))
  const units = unitsLike(bottle.unit)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const changes = Object.fromEntries(Object.entries(form).filter(([key, value]) => value.trim() !== initial[key as keyof typeof initial].trim()).map(([key, value]) => [key, value.trim()]))
    if (!Object.keys(changes).length) { setError('Nothing has changed.'); return }
    const chemicalLevel = ['chemical_name', 'cas_number', 'molecular_formula'].some(key => key in changes)
    if (chemicalLevel && !window.confirm(`Chemical name, CAS and formula belong to the chemical record, so the change applies to every bottle of ${bottle.chemical}. Continue?`)) return
    if (await run(async () => await supabase.rpc('update_inventory_item', { p_bottle_id: bottle.id, p_changes: changes, p_reason: reason.trim() || null }), 'The changes could not be saved.')) onSaved(`Saved changes to ${form.bottle_id}.`)
  }
  return <div className="modal-backdrop" onClick={onClose}><form className="modal usage-modal wide-form" onClick={event => event.stopPropagation()} onSubmit={submit}>
    <div className="modal-head"><div><span className="eyebrow">EDIT · {CATEGORY_LABEL[bottle.category].toUpperCase()}</span><h2>{bottle.chemical}</h2><p>{bottle.bottle_id} · remaining {bottle.known ? qty(bottle.quantity, bottle.unit) : 'not yet checked'} (use “Stock count” to change it)</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <div className="form-grid">
      <Field label="Chemical / solvent name" hint="Applies to all bottles of this chemical"><input required value={form.chemical_name} onChange={set('chemical_name')}/></Field>
      <Field label="CAS No"><input value={form.cas_number} onChange={set('cas_number')} placeholder="e.g. 67-64-1"/></Field>
      <Field label="Molecular formula"><input value={form.molecular_formula} onChange={set('molecular_formula')}/></Field>
      <Field label="Bottle ID" hint="Must be unique"><input required value={form.bottle_id} onChange={set('bottle_id')}/></Field>
      <Field label="Make / manufacturer"><input value={form.manufacturer} onChange={set('manufacturer')}/></Field>
      <Field label="Inventory"><select value={form.category} onChange={set('category')}>{(Object.keys(CATEGORY_LABEL) as Category[]).map(value => <option key={value} value={value}>{CATEGORY_LABEL[value]}</option>)}</select></Field>
      <Field label="Place"><input value={form.place} onChange={set('place')}/></Field>
      <Field label="Tray No."><input value={form.tray} onChange={set('tray')}/></Field>
      <Field label="Pack / bottle size"><div className="usage-amount"><input type="number" min="0" step="any" value={form.bottle_size} onChange={set('bottle_size')}/><select value={form.bottle_size_unit} onChange={set('bottle_size_unit')} aria-label="Size unit">{units.map(unit => <option key={unit}>{unit}</option>)}</select></div></Field>
      <Field label={`Initial (maximum) quantity, ${bottle.unit ?? ''}`}><input type="number" min="0" step="any" value={form.initial_quantity} onChange={set('initial_quantity')}/></Field>
      <Field label="Low-stock threshold" hint="Empty = default (below 20% of initial)"><div className="usage-amount"><input type="number" min="0" step="any" value={form.low_stock_threshold} onChange={set('low_stock_threshold')}/><select value={form.low_stock_threshold_unit} onChange={set('low_stock_threshold_unit')} aria-label="Threshold unit">{units.map(unit => <option key={unit}>{unit}</option>)}</select></div></Field>
      <Field label="Batch / lot No."><input value={form.batch_lot_number} onChange={set('batch_lot_number')}/></Field>
      <Field label="Expiry date"><input type="date" value={form.expiry_date} onChange={set('expiry_date')}/></Field>
    </div>
    <Field label="Notes"><textarea rows={2} value={form.notes} onChange={set('notes')}/></Field>
    <Field label="Reason for the change" hint="Optional; saved in the activity log with the old and new values"><input value={reason} onChange={event => setReason(event.target.value)}/></Field>
    {error && <div className="user-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving...' : 'Save changes'}</button></div>
  </form></div>
}

/** Admin: the counted remaining amount (first check of a "Needs review" bottle, or a stock-count adjustment). */
export function StockCountModal({ bottle, onClose, onSaved }: { bottle: Bottle; onClose: () => void; onSaved: (message: string) => void }) {
  const units = unitsLike(bottle.unit)
  const [amount, setAmount] = useState(''); const [unit, setUnit] = useState(bottle.unit ?? ''); const [reason, setReason] = useState(''); const { busy, error, setError, run } = useSubmit()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (amount.trim() === '' || !(Number(amount) >= 0)) { setError('Enter the counted amount.'); return }
    if (reason.trim().length < 3) { setError('Say how the amount was checked.'); return }
    if (!window.confirm(`Set ${bottle.bottle_id} to ${amount} ${unit}? ${bottle.known ? `It is recorded as ${qty(bottle.quantity, bottle.unit)}; the difference is saved as a stock-count adjustment.` : 'This becomes its opening balance.'}`)) return
    if (await run(async () => await supabase.rpc('set_verified_quantity', { p_bottle_id: bottle.id, p_quantity: Number(amount), p_quantity_unit: unit, p_reason: reason.trim() }), 'The amount could not be saved.')) onSaved(`${bottle.bottle_id}: remaining amount set to ${amount} ${unit}.`)
  }
  return <div className="modal-backdrop" onClick={onClose}><form className="modal usage-modal" onClick={event => event.stopPropagation()} onSubmit={submit}>
    <div className="modal-head"><div><span className="eyebrow">STOCK COUNT</span><h2>{bottle.chemical}</h2><p>{bottle.bottle_id} · {bottle.size != null ? `pack ${qty(bottle.size, bottle.sizeUnit)}` : 'no pack size'}</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <div className="usage-current">Recorded now<strong>{bottle.known ? qty(bottle.quantity, bottle.unit) : 'Not yet checked'}</strong>{bottle.known ? 'Only change it after a physical check; usage is recorded separately.' : 'Enter the amount that is actually in the bottle or can.'}</div>
    <label>Counted amount<div className="usage-amount"><input autoFocus type="number" inputMode="decimal" min="0" step="any" required value={amount} onChange={event => setAmount(event.target.value)}/><select value={unit} onChange={event => setUnit(event.target.value)} aria-label="Unit">{units.map(option => <option key={option}>{option}</option>)}</select></div></label>
    <label>How was it checked? <small>Required, e.g. “Weighed on 31 Oct”</small><input required value={reason} maxLength={500} onChange={event => setReason(event.target.value)}/></label>
    {error && <div className="user-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving...' : 'Save amount'}</button></div>
  </form></div>
}

/** Admin: add a physical bottle or can. Leave the amount empty when it has not been checked. */
export function AddItemModal({ category, onClose, onSaved, prefill }: { category: Category; onClose: () => void; onSaved: (message: string) => void; prefill?: Partial<Record<string, string>> }) {
  const empty = { chemical_name: '', cas_number: '', molecular_formula: '', bottle_id: '', manufacturer: '', place: '', tray: '', bottle_size: '', unit: category === 'COMMERCIAL_SOLVENT' ? 'L' : 'mL', quantity: '', low_stock_threshold: '', notes: '', ...prefill }
  const [form, setForm] = useState(empty); const { busy, error, setError, run } = useSubmit()
  const set = (key: keyof typeof empty) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!form.chemical_name.trim() || !form.bottle_id.trim()) { setError('Name and Bottle ID are required.'); return }
    const p = { ...Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value?.trim() ?? ''])), category, bottle_size_unit: form.unit, low_stock_threshold_unit: form.unit }
    if (await run(async () => await supabase.rpc('create_inventory_item', { p }), 'The item could not be added.')) onSaved(`Added ${form.chemical_name.trim()} (${form.bottle_id.trim()}).`)
  }
  return <div className="modal-backdrop" onClick={onClose}><form className="modal usage-modal wide-form" onClick={event => event.stopPropagation()} onSubmit={submit}>
    <div className="modal-head"><div><span className="eyebrow">ADD · {CATEGORY_LABEL[category].toUpperCase()}</span><h2>New {category === 'COMMERCIAL_SOLVENT' ? 'can' : 'bottle'}</h2><p>One record per physical {category === 'COMMERCIAL_SOLVENT' ? 'can' : 'bottle'}. If you add the same name again, it joins the existing record.</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <div className="form-grid">
      <Field label="Name"><input required value={form.chemical_name} onChange={set('chemical_name')} placeholder={category === 'NMR_SOLVENT' ? 'CDCl3' : 'Hexane'}/></Field>
      <Field label="CAS No" hint="Optional"><input value={form.cas_number} onChange={set('cas_number')}/></Field>
      <Field label="Bottle ID" hint="Unique"><input required value={form.bottle_id} onChange={set('bottle_id')} placeholder={category === 'NMR_SOLVENT' ? 'CD03' : 'CS-HEXANE-02'}/></Field>
      <Field label="Make / manufacturer"><input value={form.manufacturer} onChange={set('manufacturer')}/></Field>
      <Field label="Place"><input value={form.place} onChange={set('place')}/></Field>
      <Field label="Tray No." hint="Optional"><input value={form.tray} onChange={set('tray')}/></Field>
      <Field label="Pack size"><div className="usage-amount"><input type="number" min="0" step="any" required value={form.bottle_size} onChange={set('bottle_size')}/><select value={form.unit} onChange={set('unit')} aria-label="Unit">{ALL_UNITS.map(unit => <option key={unit}>{unit}</option>)}</select></div></Field>
      <Field label={`Amount in it now (${form.unit})`} hint="Leave empty if not checked yet"><input type="number" min="0" step="any" value={form.quantity} onChange={set('quantity')}/></Field>
      <Field label={`Low-stock threshold (${form.unit})`} hint="Empty = below 20% of pack size"><input type="number" min="0" step="any" value={form.low_stock_threshold} onChange={set('low_stock_threshold')}/></Field>
    </div>
    <Field label="Notes"><textarea rows={2} value={form.notes} onChange={set('notes')}/></Field>
    {error && <div className="user-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving...' : 'Add'}</button></div>
  </form></div>
}
