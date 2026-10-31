import { useRef, useState, type FormEvent } from 'react'
import { ArrowDownToLine, ArrowLeft, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { explainError } from '../lib/errors'
import { CATEGORY_LABEL, qty, type Bottle } from '../data/InventoryProvider'
import { convert, unitsLike } from '../lib/units'

export default function RecordUsageModal({ bottle, onClose, onRecorded }: { bottle: Bottle; onClose: () => void; onRecorded: (message: string) => void }) {
  const units = unitsLike(bottle.unit)
  const [amount, setAmount] = useState(''); const [unit, setUnit] = useState(bottle.unit ?? ''); const [purpose, setPurpose] = useState(''); const [experiment, setExperiment] = useState(''); const [notes, setNotes] = useState('')
  const [reviewing, setReviewing] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const value = Number(amount)
  const inBottleUnit = convert(value, unit, bottle.unit)
  const tooMuch = Number.isFinite(inBottleUnit) && inBottleUnit > bottle.quantity + 1e-9
  const remaining = Number.isFinite(inBottleUnit) ? Number((bottle.quantity - inBottleUnit).toFixed(6)) : bottle.quantity
  const blocked = !bottle.known || units.length === 0

  const review = (event: FormEvent) => {
    event.preventDefault()
    if (!(value > 0)) { setError('Enter the amount used.'); return }
    if (tooMuch) { setError(`Only ${qty(bottle.quantity, bottle.unit)} left in this bottle.`); return }
    setError(''); setReviewing(true)
  }
  const confirm = async () => {
    if (inFlight.current) return // one submission per click, even on double-click
    inFlight.current = true; setBusy(true); setError('')
    const { data, error: rpcError } = await supabase.rpc('record_usage', { p_bottle_id: bottle.id, p_quantity: value, p_quantity_unit: unit, p_purpose: purpose.trim() || null, p_notes: notes.trim() || null, p_experiment: experiment.trim() || null })
    inFlight.current = false; setBusy(false)
    if (rpcError) { setError(await explainError(rpcError, 'Usage could not be recorded.')); setReviewing(false); return }
    const result = data as { remaining: number; unit: string }
    onRecorded(`Recorded ${value} ${unit} of ${bottle.chemical} (${bottle.bottle_id}). ${Number(result.remaining)} ${result.unit} left.`)
  }

  return <div className="modal-backdrop" onClick={onClose}><form className="modal usage-modal" onClick={event => event.stopPropagation()} onSubmit={review}>
    <div className="modal-head"><div><span className="eyebrow">RECORD USAGE · {CATEGORY_LABEL[bottle.category].toUpperCase()}</span><h2>{bottle.chemical}</h2><p>{[bottle.bottle_id, bottle.cas, bottle.manufacturer, [bottle.place, bottle.tray].filter(Boolean).join(' / ')].filter(Boolean).join(' · ')}</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <div className="usage-current">Available now<strong>{bottle.known ? qty(bottle.quantity, bottle.unit) : 'Not yet checked'}</strong>{bottle.size != null && <>of {qty(bottle.size, bottle.sizeUnit)} bottle</>}</div>
    {!bottle.known ? <div className="user-error">This bottle's remaining amount has not been checked yet, so usage cannot be recorded. Ask the Admin to enter the counted amount.</div>
    : units.length === 0 ? <div className="user-error">This bottle has no unit recorded, so usage cannot be recorded. Ask the Admin to correct it.</div>
    : reviewing ? <div className="review-box" role="group" aria-label="Review usage">
      <h3>Check before saving</h3>
      <dl><dt>Amount used</dt><dd><b>{value} {unit}</b>{unit !== bottle.unit && Number.isFinite(inBottleUnit) ? ` (${Number(inBottleUnit.toFixed(6))} ${bottle.unit})` : ''}</dd>
        <dt>Before</dt><dd>{qty(bottle.quantity, bottle.unit)}</dd><dt>After</dt><dd><b>{remaining} {bottle.unit}</b></dd>
        {experiment.trim() && <><dt>Experiment / project</dt><dd>{experiment.trim()}</dd></>}{purpose.trim() && <><dt>Purpose</dt><dd>{purpose.trim()}</dd></>}{notes.trim() && <><dt>Notes</dt><dd>{notes.trim()}</dd></>}</dl>
      <p className="muted-note">Saved with your name and the current date and time. If it is wrong, it can be corrected later with a reason; the original entry is kept.</p>
    </div> : <>
      <label>Amount used<div className="usage-amount"><input autoFocus type="number" inputMode="decimal" min="0" step="any" required value={amount} onChange={event => setAmount(event.target.value)} placeholder="e.g. 5"/><select value={unit} onChange={event => setUnit(event.target.value)} aria-label="Unit">{units.map(option => <option key={option} value={option}>{option}</option>)}</select></div></label>
      <label>Experiment / project <small>Optional</small><input value={experiment} maxLength={200} onChange={event => setExperiment(event.target.value)} placeholder="Project A, batch 12"/></label>
      <label>Purpose <small>Optional</small><input value={purpose} maxLength={200} onChange={event => setPurpose(event.target.value)} placeholder="Synthesis of compound 4b"/></label>
      <label>Notes <small>Optional</small><textarea rows={2} value={notes} maxLength={1000} onChange={event => setNotes(event.target.value)}/></label>
      {value > 0 && !tooMuch && <div className="usage-after">After this: {remaining} {bottle.unit} left</div>}
      {tooMuch && <div className="user-error">That is more than the {qty(bottle.quantity, bottle.unit)} left.</div>}
    </>}
    {error && <div className="user-error">{error}</div>}
    <div className="modal-actions">{reviewing ? <><button type="button" className="secondary" disabled={busy} onClick={() => setReviewing(false)}><ArrowLeft size={15}/> Change</button><button type="button" className="primary" disabled={busy} onClick={() => void confirm()}><ArrowDownToLine size={16}/> {busy ? 'Saving...' : 'Confirm and save'}</button></>
      : <><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={blocked || !(value > 0) || tooMuch}>Review</button></>}</div>
  </form></div>
}
