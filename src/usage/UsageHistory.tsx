import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ChevronDown, ChevronRight, History, PencilLine, Search, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { explainError } from '../lib/errors'
import { useAuth } from '../auth/AuthProvider'
import { CATEGORY_LABEL, fetchAll, loadUsageSince, qty, remainingText, round, toUsage, useInventory, type Bottle, type Category, type Usage } from '../data/InventoryProvider'
import { ExportMenu, LastUsed, Pager, usePaged } from '../components/TableTools'
import { fmtDateTime, type ExportColumn } from '../lib/exporter'
import { matchesChemical } from '../lib/search'
import { unitsLike } from '../lib/units'

type Correction = { id: string; original_transaction_id: string; corrected_by: string; old_quantity: number; new_quantity: number; quantity_unit: string; old_purpose: string | null; new_purpose: string | null; old_experiment: string | null; new_experiment: string | null; old_notes: string | null; new_notes: string | null; reason: string; created_at: string }

export const usageColumns: ExportColumn<Usage>[] = [
  { header: 'Date and time', value: r => fmtDateTime(r.created_at) }, { header: 'User name', value: r => r.user_name }, { header: 'User email', value: r => r.user_email },
  { header: 'Chemical / solvent', value: r => r.chemical }, { header: 'CAS No', value: r => r.cas }, { header: 'Inventory', value: r => CATEGORY_LABEL[r.category] }, { header: 'Bottle ID', value: r => r.bottle_code }, { header: 'Make', value: r => r.make },
  { header: 'Quantity consumed', value: r => round(-r.quantity_change) }, { header: 'Unit', value: r => r.quantity_unit }, { header: 'Originally recorded', value: r => (r.corrections ? round(r.recorded) : '') },
  { header: 'Quantity before', value: r => round(r.quantity_before) }, { header: 'Quantity after', value: r => round(r.quantity_after) },
  { header: 'Experiment / project', value: r => r.experiment }, { header: 'Purpose', value: r => r.purpose }, { header: 'Notes', value: r => r.notes }, { header: 'Corrections', value: r => r.corrections || '' },
]

/** Admin: any entry. Researcher: own entries within 24 hours (the database enforces the same rule). */
export function canCorrect(row: Usage, me: { id: string; role: string } | null) {
  if (!me) return false
  if (me.role === 'ADMIN') return true
  return row.user_id === me.id && Date.now() - new Date(row.created_at).getTime() < 24 * 3600 * 1000
}

async function loadCorrections(ids: string[]) {
  if (!ids.length) return new Map<string, Correction[]>()
  const rows: Correction[] = []
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from('transaction_corrections').select('*').in('original_transaction_id', ids.slice(i, i + 150)).order('created_at')
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []) as Correction[])
  }
  const map = new Map<string, Correction[]>()
  for (const row of rows) map.set(row.original_transaction_id, [...(map.get(row.original_transaction_id) ?? []), row])
  return map
}

export function UsageTable({ rows, showBottle = true, onCorrect, corrections }: { rows: Usage[]; showBottle?: boolean; onCorrect: (row: Usage) => void; corrections: Map<string, Correction[]> }) {
  const { profile } = useAuth(); const { people } = useInventory(); const [open, setOpen] = useState<string | null>(null)
  const span = showBottle ? 9 : 7
  return <div className="table-wrap"><table className="cards"><thead><tr><th>WHEN</th><th>USER</th>{showBottle && <><th>CHEMICAL / SOLVENT</th><th>BOTTLE</th></>}<th>USED</th><th>BEFORE → AFTER</th><th>EXPERIMENT / PURPOSE</th><th>NOTES</th><th></th></tr></thead><tbody>
    {rows.map(row => { const history = corrections.get(row.id) ?? []; const expanded = open === row.id; return <Fragment key={row.id}><tr>
      <td>{fmtDateTime(row.created_at)}</td>
      <td><b>{row.user_id === profile?.id ? 'You' : row.user_name ?? 'Unknown user'}</b>{row.user_email && <small className="cell-note">{row.user_email}</small>}</td>
      {showBottle && <><td><b>{row.chemical}</b><small className="cell-note">{[CATEGORY_LABEL[row.category], row.make].filter(Boolean).join(' · ')}</small></td><td className="mono">{row.bottle_code}</td></>}
      <td><b>{qty(-row.quantity_change, row.quantity_unit)}</b>{row.corrections > 0 && <small className="cell-note corrected-note">Corrected (recorded {qty(row.recorded, row.quantity_unit)})</small>}</td>
      <td>{qty(row.quantity_before, row.quantity_unit)} → {qty(row.quantity_after, row.quantity_unit)}{row.corrections > 0 && <small className="cell-note">as first recorded</small>}</td>
      <td className="wrap-cell">{row.experiment && <b>{row.experiment}</b>}{row.purpose && <small className="cell-note">{row.purpose}</small>}{!row.experiment && !row.purpose && '—'}</td>
      <td className="wrap-cell">{row.notes ?? '—'}</td>
      <td><div className="user-actions">{canCorrect(row, profile) && <button className="table-action" onClick={() => onCorrect(row)}><PencilLine size={12}/> Correct</button>}{history.length > 0 && <button className="table-action" onClick={() => setOpen(expanded ? null : row.id)} aria-expanded={expanded}>{expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>} {history.length} correction{history.length > 1 ? 's' : ''}</button>}</div></td>
    </tr>{expanded && <tr className="detail-row"><td colSpan={span}><div className="correction-list">{history.map(c => <div key={c.id}><b>{fmtDateTime(c.created_at)} · {people.get(c.corrected_by) ?? 'Unknown user'}</b><span>Quantity {qty(c.old_quantity, c.quantity_unit)} → {qty(c.new_quantity, c.quantity_unit)}{c.old_purpose !== c.new_purpose ? ` · purpose “${c.old_purpose ?? '—'}” → “${c.new_purpose ?? '—'}”` : ''}{c.old_experiment !== c.new_experiment ? ` · experiment “${c.old_experiment ?? '—'}” → “${c.new_experiment ?? '—'}”` : ''}{c.old_notes !== c.new_notes ? ' · notes changed' : ''}</span><small>Reason: {c.reason}</small></div>)}</div></td></tr>}</Fragment> })}
    {!rows.length && <tr><td colSpan={span}><div className="empty-users">No usage recorded.</div></td></tr>}
  </tbody></table></div>
}

export function CorrectUsageModal({ row, onClose, onDone }: { row: Usage; onClose: () => void; onDone: (message: string) => void }) {
  const units = unitsLike(row.quantity_unit)
  const [amount, setAmount] = useState(String(round(-row.quantity_change))); const [unit, setUnit] = useState(row.quantity_unit ?? ''); const [reason, setReason] = useState('')
  const [experiment, setExperiment] = useState(row.experiment ?? ''); const [purpose, setPurpose] = useState(row.purpose ?? ''); const [notes, setNotes] = useState(row.notes ?? '')
  const [confirming, setConfirming] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const inFlight = useRef(false)
  const value = Number(amount)
  const check = (event: FormEvent) => { event.preventDefault(); if (!(value >= 0) || amount.trim() === '') { setError('Enter the amount actually used (0 if none).'); return } if (reason.trim().length < 3) { setError('Give a reason for the correction.'); return } setError(''); setConfirming(true) }
  const save = async () => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError('')
    const changed = (next: string, prev: string | null) => (next.trim() !== (prev ?? '') ? next.trim() || null : null)
    const { data, error: rpcError } = await supabase.rpc('correct_usage', { p_transaction_id: row.id, p_quantity: value, p_quantity_unit: unit, p_reason: reason.trim(), p_purpose: changed(purpose, row.purpose), p_experiment: changed(experiment, row.experiment), p_notes: changed(notes, row.notes) })
    inFlight.current = false; setBusy(false)
    if (rpcError) { setError(await explainError(rpcError, 'The correction could not be saved.')); setConfirming(false); return }
    const result = data as { old_quantity: number; new_quantity: number; unit: string; remaining: number }
    onDone(`Corrected ${row.chemical} (${row.bottle_code}): ${round(result.old_quantity)} → ${round(result.new_quantity)} ${result.unit}. ${round(result.remaining)} ${result.unit} left. The original entry is kept in the history.`)
  }
  return <div className="modal-backdrop" onClick={onClose}><form className="modal usage-modal" onClick={event => event.stopPropagation()} onSubmit={check}>
    <div className="modal-head"><div><span className="eyebrow">CORRECT USAGE ENTRY</span><h2>{row.chemical}</h2><p>{row.bottle_code} · recorded {fmtDateTime(row.created_at)} by {row.user_name ?? 'unknown user'}</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <div className="usage-current">Current entry<strong>{qty(-row.quantity_change, row.quantity_unit)}</strong>{row.corrections > 0 ? `First recorded as ${qty(row.recorded, row.quantity_unit)}; corrected ${row.corrections} time${row.corrections > 1 ? 's' : ''}` : 'As originally recorded'}</div>
    {confirming ? <div className="review-box"><h3>Confirm the correction</h3><dl><dt>Quantity</dt><dd>{qty(-row.quantity_change, row.quantity_unit)} → <b>{value} {unit}</b></dd><dt>Reason</dt><dd>{reason.trim()}</dd></dl><p className="muted-note">The original entry stays in the history. The difference is added as a separate adjustment, and your name, the time and the reason are recorded.</p></div> : <>
      <label>Amount actually used<div className="usage-amount"><input type="number" inputMode="decimal" min="0" step="any" required value={amount} onChange={event => setAmount(event.target.value)}/><select value={unit} onChange={event => setUnit(event.target.value)} aria-label="Unit">{units.map(option => <option key={option} value={option}>{option}</option>)}</select></div></label>
      <label>Experiment / project<input value={experiment} maxLength={200} onChange={event => setExperiment(event.target.value)}/></label>
      <label>Purpose<input value={purpose} maxLength={200} onChange={event => setPurpose(event.target.value)}/></label>
      <label>Notes<textarea rows={2} value={notes} maxLength={1000} onChange={event => setNotes(event.target.value)}/></label>
      <label>Reason for correction <small>Required, e.g. “Misread the syringe”</small><input required value={reason} maxLength={500} onChange={event => setReason(event.target.value)}/></label>
    </>}
    {error && <div className="user-error">{error}</div>}
    <div className="modal-actions">{confirming ? <><button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Back</button><button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save correction'}</button></> : <><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary">Review correction</button></>}</div>
  </form></div>
}

function useCorrections(rows: Usage[]) {
  const [map, setMap] = useState<Map<string, Correction[]>>(new Map())
  const ids = useMemo(() => rows.filter(row => row.corrections > 0).map(row => row.id).join(','), [rows])
  useEffect(() => { let live = true; loadCorrections(ids ? ids.split(',') : []).then(next => { if (live) setMap(next) }).catch(() => undefined); return () => { live = false } }, [ids])
  return map
}

/** Initial, consumed, used-before-tracking and remaining for one bottle. */
export function QuantityFigures({ bottle }: { bottle: Bottle }) {
  const initial = bottle.initial ?? null
  return <div className="figures"><div><span>Initial (maximum)</span><b>{qty(initial, bottle.unit)}</b>{bottle.size != null && <small>Pack {qty(bottle.size, bottle.sizeUnit)}</small>}</div><div><span>Total consumed</span><b>{qty(bottle.totalUsed, bottle.unit)}</b><small>Recorded usage</small></div>{bottle.untracked > 0 && <div><span>Used before tracking</span><b>{qty(bottle.untracked, bottle.unit)}</b><small>Not attributed to anyone</small></div>}<div className="remaining"><span>Remaining</span><b>{remainingText(bottle)}</b><small>{bottle.known ? 'Calculated from transactions' : 'Admin must enter the counted amount'}</small></div></div>
}

export function BottleHistoryModal({ bottle, onClose, onChanged }: { bottle: Bottle; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Usage[] | null>(null); const [error, setError] = useState(''); const [correcting, setCorrecting] = useState<Usage | null>(null); const [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    try { const data = await fetchAll<any>((from, to) => supabase.from('usage_history').select('*').eq('bottle_id', bottle.id).order('created_at', { ascending: false }).range(from, to)); setRows(data.map(toUsage)) }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load usage history.') }
  }, [bottle.id])
  useEffect(() => { void load() }, [load])
  const corrections = useCorrections(rows ?? [])
  const columns = usageColumns.filter(column => !['Chemical / solvent', 'CAS No', 'Inventory', 'Bottle ID', 'Make'].includes(column.header))
  return <div className="modal-backdrop" onClick={onClose}><div className="modal wide-modal" onClick={event => event.stopPropagation()} role="dialog" aria-label={`Usage history of ${bottle.bottle_id}`}>
    <div className="modal-head"><div><span className="eyebrow">USAGE HISTORY · {bottle.bottle_id}</span><h2>{bottle.chemical}</h2><p>{[bottle.manufacturer, [bottle.place, bottle.tray].filter(Boolean).join(' / ')].filter(Boolean).join(' · ')}</p></div><button type="button" className="close" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    <QuantityFigures bottle={bottle}/>
    <div className="last-used-line"><span>Last used by</span> <LastUsed bottle={bottle}/></div>
    {notice && <div className="admin-success">{notice}</div>}{error && <div className="user-error">{error}</div>}
    <div className="modal-toolbar"><span className="muted">{rows ? `${rows.length} entries, most recent first` : 'Loading...'}</span>{rows && <ExportMenu baseName={`usage-${bottle.bottle_id}`} title={`Usage history of ${bottle.chemical} (${bottle.bottle_id})`} columns={columns} scopes={[{ key: 'all', label: 'All entries', rows }]}/>}</div>
    {rows && <UsageTable rows={rows} showBottle={false} corrections={corrections} onCorrect={setCorrecting}/>}
    {correcting && <CorrectUsageModal row={correcting} onClose={() => setCorrecting(null)} onDone={message => { setCorrecting(null); setNotice(message); void load(); onChanged() }}/>}
  </div></div>
}

const CATEGORY_FILTERS: Array<['' | Category, string]> = [['', 'All inventories'], ['CHEMICAL', 'Chemicals'], ['COMMERCIAL_SOLVENT', 'Commercial solvents'], ['NMR_SOLVENT', 'NMR solvents']]
export function UsageHistoryPage() {
  const { profile } = useAuth(); const { refresh } = useInventory()
  const [rows, setRows] = useState<Usage[] | null>(null); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [correcting, setCorrecting] = useState<Usage | null>(null)
  const [query, setQuery] = useState(''); const [category, setCategory] = useState<'' | Category>(''); const [who, setWho] = useState<'all' | 'me' | 'corrected'>('all'); const [from, setFrom] = useState(''); const [to, setTo] = useState('')
  const load = useCallback(async () => { try { setRows((await loadUsageSince(null)).reverse()) } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load usage history.') } }, [])
  useEffect(() => { void load() }, [load])
  const filtered = useMemo(() => (rows ?? []).filter(row => (!category || row.category === category) && (who !== 'me' || row.user_id === profile?.id) && (who !== 'corrected' || row.corrections > 0)
    && (!from || row.created_at >= new Date(`${from}T00:00:00`).toISOString()) && (!to || row.created_at <= new Date(`${to}T23:59:59`).toISOString())
    && matchesChemical(query, row.chemical, row.cas, row.bottle_code, row.make, row.user_name, row.user_email, row.experiment, row.purpose)), [rows, category, who, from, to, query, profile?.id])
  const paged = usePaged(filtered)
  const corrections = useCorrections(paged.visible)
  return <><div className="title-row"><div><p className="eyebrow">TRANSACTIONS</p><h1>Usage history</h1><p className="subtitle">Every recorded usage, most recent first. Corrections are shown beside the original entry, which is never changed.</p></div></div>
    {notice && <div className="admin-success page-notice">{notice}</div>}{error && <div className="user-error">{error}</div>}
    <section className="panel table-panel"><div className="inventory-toolbar wrap-toolbar"><div className="search"><Search size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search chemical, CAS, Bottle ID, user, experiment..."/></div>
      <select className="analytics-select" value={category} onChange={event => setCategory(event.target.value as '' | Category)} aria-label="Inventory">{CATEGORY_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select className="analytics-select" value={who} onChange={event => setWho(event.target.value as typeof who)} aria-label="Entries"><option value="all">Everyone</option><option value="me">Only mine</option><option value="corrected">Corrected entries</option></select>
      <label className="date-filter">From<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label><label className="date-filter">To<input type="date" value={to} onChange={event => setTo(event.target.value)}/></label>
      <ExportMenu baseName="usage-history" title="Usage history" columns={usageColumns} scopes={[{ key: 'matching', label: 'All matching entries', rows: filtered }, { key: 'page', label: 'Current page', rows: paged.visible }, { key: 'all', label: 'Entire history', rows: rows ?? [] }]}/></div>
      {rows === null ? <div className="loading-row">Loading usage history...</div> : <><UsageTable rows={paged.visible} corrections={corrections} onCorrect={setCorrecting}/><Pager {...paged} total={filtered.length} noun="entries"/></>}
    </section>
    {correcting && <CorrectUsageModal row={correcting} onClose={() => setCorrecting(null)} onDone={message => { setCorrecting(null); setNotice(message); void load(); void refresh() }}/>}
    <p className="muted-note page-foot"><History size={13}/> Researchers can correct their own entries within 24 hours; the Admin can correct any entry. Every correction needs a reason.</p></>
}
