import { useRef, useState, type FormEvent } from 'react'
import { ArrowDownToLine, X } from 'lucide-react'
import { getSupabaseErrorMessage, supabase } from '../lib/supabase'
import type { Bottle } from '../data/InventoryProvider'
import { convert, unitsLike } from '../lib/units'


// record_usage error codes -> readable messages.
function explain(message: string) {
  if (message.includes('Could not find the function public.record_usage')) return 'Recording usage is not installed in Supabase yet. Ask the Admin to apply migration 20261018150000_record_usage.sql.'
  if (message.startsWith('INSUFFICIENT_QUANTITY: ')) return message.replace('INSUFFICIENT_QUANTITY: ', 'Not enough left: ')
  if (message.startsWith('UNIT_MISMATCH: ')) return message.replace('UNIT_MISMATCH: ', 'Wrong unit: ')
  if (message.includes('ACCOUNT_NOT_ACTIVE')) return 'Your account is not active.'
  if (message.includes('BOTTLE_NOT_FOUND')) return 'This bottle no longer exists.'
  return message
}

export default function RecordUsageModal({ bottle, onClose, onRecorded }: { bottle: Bottle; onClose: () => void; onRecorded: (message: string) => void }) {
  const units = unitsLike(bottle.unit)
  const [amount, setAmount] = useState(''); const [unit, setUnit] = useState(bottle.unit ?? ''); const [purpose, setPurpose] = useState('')
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const value = Number(amount)
  const inBottleUnit = convert(value, unit, bottle.unit)
  const tooMuch = Number.isFinite(inBottleUnit) && inBottleUnit > bottle.quantity + 1e-9
  const remaining = Number.isFinite(inBottleUnit) ? Number((bottle.quantity - inBottleUnit).toFixed(6)) : bottle.quantity

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (inFlight.current) return // one submission per click, even on double-click
    if (!(value > 0)) { setError('Enter the amount used.'); return }
    if (tooMuch) { setError(`Only ${bottle.quantity} ${bottle.unit} left in this bottle.`); return }
    inFlight.current = true; setBusy(true); setError('')
    const { data, error: rpcError } = await supabase.rpc('record_usage', { p_bottle_id: bottle.id, p_quantity: value, p_quantity_unit: unit, p_purpose: purpose.trim() || null })
    inFlight.current = false; setBusy(false)
    if (rpcError) { setError(explain(await getSupabaseErrorMessage(rpcError, 'Usage could not be recorded.'))); return }
    const result = data as { remaining: number; unit: string }
    onRecorded(`Recorded ${value} ${unit} of ${bottle.chemical}. ${Number(result.remaining)} ${result.unit} left.`)
  }

  return <div className="modal-backdrop" onClick={onClose}><form className="modal usage-modal" onClick={event => event.stopPropagation()} onSubmit={submit}>
    <div className="modal-head"><div><span className="eyebrow">RECORD USAGE</span><h2>{bottle.chemical}</h2><p>{[bottle.cas, bottle.manufacturer, [bottle.place, bottle.tray].filter(Boolean).join(' / ')].filter(Boolean).join(' · ')}</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <div className="usage-current">Available now<strong>{bottle.quantity} {bottle.unit}</strong>{bottle.size != null && <>of {bottle.size} {bottle.sizeUnit} bottle</>}</div>
    {units.length === 0 ? <div className="user-error">This bottle has no unit recorded, so usage cannot be recorded. Ask the Admin to correct it.</div> : <>
      <label>Amount used<div className="usage-amount"><input autoFocus type="number" inputMode="decimal" min="0" step="any" required value={amount} onChange={event => setAmount(event.target.value)} placeholder="e.g. 5"/><select value={unit} onChange={event => setUnit(event.target.value)} aria-label="Unit">{units.map(option => <option key={option} value={option}>{option}</option>)}</select></div></label>
      <label>Purpose <small>Optional, e.g. experiment or project</small><input value={purpose} maxLength={200} onChange={event => setPurpose(event.target.value)} placeholder="Synthesis of compound 4b"/></label>
      {value > 0 && !tooMuch && <div className="usage-after">After this: {remaining} {bottle.unit} left</div>}
      {tooMuch && <div className="user-error">That is more than the {bottle.quantity} {bottle.unit} left.</div>}
    </>}
    {error && <div className="user-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || units.length === 0 || !(value > 0) || tooMuch}><ArrowDownToLine size={16}/> {busy ? 'Saving...' : 'Record usage'}</button></div>
  </form></div>
}
