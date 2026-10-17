import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, ShieldCheck, Upload } from 'lucide-react'
import { getSupabaseErrorMessage, supabase } from '../lib/supabase'
import { autoMap, buildRows, downloadTemplate, FIELDS, readSpreadsheet, type FieldKey, type Mapping, type Sheet } from './spreadsheet'

type RowResult = { row: number; status: 'valid' | 'imported' | 'rejected'; bottle_id: string | null; chemical: string | null; chemical_action?: string; supplier_action?: string; location_action?: string; status_assigned?: string; errors: string[]; warnings: string[] }
type Summary = { status: 'preview' | 'blocked' | 'committed' | 'already_imported'; batch_id: string; file_name: string; total_rows: number; imported_rows: number; rejected_rows: number; chemicals: { matched: number; created: number }; suppliers: { matched: number; created: number }; locations: { matched: number; created: number }; rows: RowResult[]; imported_at?: string | null }

// Server error codes from import_inventory_batch -> readable messages.
function explain(message: string) {
  if (message.includes('ONLY_DESIGNATED_ADMIN_CAN_IMPORT')) return 'Only the active designated Admin can import inventory.'
  if (message.includes('Could not find the function public.import_inventory_batch')) return 'The import function is not installed in Supabase yet. Apply migration 20261018090000_activity_log_and_inventory_import.sql.'
  if (message.startsWith('DUPLICATE_FILE')) return message.replace('DUPLICATE_FILE: ', 'Duplicate import blocked: ')
  return message
}

export default function ImportPanel({ onImported }: { onImported: () => Promise<void> | void }) {
  const [sheet, setSheet] = useState<Sheet | null>(null); const [mapping, setMapping] = useState<Mapping>({}); const [summary, setSummary] = useState<Summary | null>(null)
  const [validatedPayload, setValidatedPayload] = useState(''); const [skipRejected, setSkipRejected] = useState(false); const [busy, setBusy] = useState<'' | 'reading' | 'validating' | 'importing'>(''); const [error, setError] = useState('')
  const inFlight = useRef(false); const idempotencyKey = useRef<string | null>(null); const fileInput = useRef<HTMLInputElement>(null)
  const rows = useMemo(() => (sheet ? buildRows(sheet, mapping) : []), [sheet, mapping])
  const payload = useMemo(() => JSON.stringify(rows), [rows])
  const missing = FIELDS.filter(field => field.required && mapping[field.key] == null && !(field.key === 'quantity_unit' && mapping.current_quantity != null))
  const done = summary?.status === 'committed' || summary?.status === 'already_imported'
  const validated = summary?.status === 'preview' && validatedPayload === payload
  const reset = () => { setSheet(null); setMapping({}); setSummary(null); setValidatedPayload(''); setSkipRejected(false); setError(''); idempotencyKey.current = null; if (fileInput.current) fileInput.current.value = '' }

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    reset(); setBusy('reading')
    try { const next = await readSpreadsheet(file); setSheet(next); setMapping(autoMap(next.headers)) }
    catch (readError) { setError(readError instanceof Error ? readError.message : 'Unable to read the file.') }
    finally { setBusy('') }
  }
  const call = async (dryRun: boolean) => {
    if (!sheet || inFlight.current) return
    inFlight.current = true; setError(''); setBusy(dryRun ? 'validating' : 'importing')
    // One key per validated payload: a retry or double click replays the same batch instead of importing twice.
    if (dryRun || !idempotencyKey.current) idempotencyKey.current = crypto.randomUUID()
    try {
      const { data, error: rpcError } = await supabase.rpc('import_inventory_batch', { p_idempotency_key: idempotencyKey.current, p_file_name: sheet.fileName, p_file_sha256: sheet.sha256, p_rows: rows, p_dry_run: dryRun, p_skip_rejected: !dryRun && skipRejected })
      if (rpcError) throw rpcError
      const result = data as Summary
      setSummary(result)
      if (dryRun) setValidatedPayload(payload)
      if (result.status === 'committed' || result.status === 'already_imported') await onImported()
      if (result.status === 'blocked') setValidatedPayload('')
    } catch (rpcError) {
      setError(explain(await getSupabaseErrorMessage(rpcError, 'The import failed. No records were written.')))
      if (!dryRun) setError(current => `${current} The batch was rolled back; no records from this file were saved.`)
    } finally { inFlight.current = false; setBusy('') }
  }

  const rejected = summary?.rows.filter(row => row.status === 'rejected') ?? []
  const warned = summary?.rows.filter(row => row.status !== 'rejected' && row.warnings.length) ?? []
  const canImport = validated && !busy && summary!.imported_rows > 0 && (summary!.rejected_rows === 0 || skipRejected)

  return <section className="panel admin-section import-panel">
    <div className="panel-heading"><div><h2>Import inventory</h2><p>Upload → preview → validate → confirm. Each row becomes one physical bottle; existing bottles are never overwritten.</p></div></div>
    <div className="import-actions">
      <label className={`primary${busy || summary?.status === 'committed' ? ' disabled' : ''}`}><Upload size={16}/> {busy === 'reading' ? 'Reading...' : sheet ? 'Choose another file' : 'Choose .xlsx or .csv'}<input ref={fileInput} hidden type="file" accept=".csv,.xlsx" disabled={Boolean(busy)} onChange={event => void choose(event)}/></label>
      <button className="secondary" onClick={downloadTemplate}><FileSpreadsheet size={16}/> Blank template</button>
      {sheet && <span className="muted">{sheet.fileName} · {sheet.rows.length} data rows</span>}
    </div>
    {error && <div className="user-error import-message">{error}</div>}

    {sheet && !done && <>
      <h3 className="import-step">1. Map columns</h3>
      <div className="mapping-grid">{FIELDS.map(field => <label key={field.key}><span>{field.label}{field.required && <b> *</b>}</span><select value={mapping[field.key] ?? ''} onChange={event => { const value = event.target.value; setMapping(current => { const next = { ...current }; if (value === '') delete next[field.key as FieldKey]; else next[field.key as FieldKey] = Number(value); return next }) }}><option value="">— not in file —</option>{sheet.headers.map((header, index) => <option key={index} value={index}>{header}</option>)}</select></label>)}</div>
      {missing.length > 0 && <div className="user-error import-message">Map the required column{missing.length > 1 ? 's' : ''}: {missing.map(field => field.label).join(', ')}.</div>}
      <p className="muted">Quantity unit may also be written inside the quantity cell (e.g. “25 g”). Dates must be YYYY-MM-DD, “18-Apr-2027”, or Excel date cells.</p>

      <h3 className="import-step">2. Preview</h3>
      <div className="table-wrap"><table><thead><tr><th>ROW</th><th>CHEMICAL</th><th>CAS</th><th>BOTTLE ID</th><th>QUANTITY</th><th>BOTTLE SIZE</th><th>SUPPLIER</th><th>LOCATION</th><th>EXPIRY</th></tr></thead><tbody>{rows.slice(0, 10).map(row => <tr key={row.row_number}><td>{row.row_number}</td><td>{String(row.chemical_name)}</td><td>{String(row.cas_number)}</td><td className="mono">{String(row.bottle_id) || <span className="muted">generated</span>}</td><td>{String(row.current_quantity)} {String(row.quantity_unit)}</td><td>{String(row.bottle_size)} {String(row.bottle_size_unit)}</td><td>{String(row.supplier)}</td><td>{[row.room, row.cabinet, row.shelf, row.tray].filter(Boolean).join(' / ')}</td><td>{String(row.expiry_date)}</td></tr>)}</tbody></table></div>
      {rows.length > 10 && <p className="muted">Showing 10 of {rows.length} rows. All rows are validated.</p>}

      <h3 className="import-step">3. Validate</h3>
      <div className="import-actions"><button className="secondary" disabled={Boolean(busy) || missing.length > 0} onClick={() => void call(true)}><ShieldCheck size={16}/> {busy === 'validating' ? 'Validating...' : validated ? 'Validate again' : `Validate ${rows.length} rows with Supabase`}</button><span className="muted">Runs every check and match on the server, then rolls back. Nothing is saved.</span></div>
      {summary?.status === 'preview' && validatedPayload !== payload && <div className="user-error import-message">The mapping changed after validation. Validate again before importing.</div>}
    </>}

    {summary && <SummaryView summary={summary} rejected={rejected} warned={warned}/>}

    {sheet && validated && !done && <>
      <h3 className="import-step">4. Confirm import</h3>
      {summary!.rejected_rows > 0 && <label className="skip-check"><input type="checkbox" checked={skipRejected} onChange={event => setSkipRejected(event.target.checked)}/> Skip the {summary!.rejected_rows} rejected row{summary!.rejected_rows > 1 ? 's' : ''} and import only the {summary!.imported_rows} valid row{summary!.imported_rows === 1 ? '' : 's'}</label>}
      <div className="import-actions"><button className="primary" disabled={!canImport} onClick={() => void call(false)}><Upload size={16}/> {busy === 'importing' ? 'Importing...' : `Import ${summary!.imported_rows} bottle${summary!.imported_rows === 1 ? '' : 's'}`}</button><button className="secondary" disabled={Boolean(busy)} onClick={reset}>Cancel</button></div>
      <p className="muted">The whole batch is written in one database transaction. If any write fails, nothing is saved.</p>
    </>}
    {done && <div className="import-actions"><button className="secondary" onClick={reset}>Import another file</button></div>}
  </section>
}

function SummaryView({ summary, rejected, warned }: { summary: Summary; rejected: RowResult[]; warned: RowResult[] }) {
  const committed = summary.status === 'committed' || summary.status === 'already_imported'
  const verb = committed ? 'Imported' : 'Ready to import'
  return <div className="import-summary">
    {summary.status === 'committed' && <div className="admin-success"><CheckCircle2 size={16}/> Saved to Supabase: {summary.imported_rows} bottle{summary.imported_rows === 1 ? '' : 's'} from {summary.file_name}{summary.imported_at ? ` at ${new Date(summary.imported_at).toLocaleString()}` : ''}. Batch {summary.batch_id}.</div>}
    {summary.status === 'already_imported' && <div className="admin-success"><CheckCircle2 size={16}/> This submission was already saved (batch {summary.batch_id}). No duplicate records were created.</div>}
    {summary.status === 'blocked' && <div className="user-error import-message"><AlertTriangle size={14}/> Nothing was imported: {summary.imported_rows === 0 ? 'no valid rows.' : 'some rows were rejected. Fix them or choose to skip them.'}</div>}
    <div className="admin-stats import-stats">
      <div><strong>{summary.imported_rows}</strong><span>{verb}</span></div>
      <div><strong>{summary.rejected_rows}</strong><span>Rejected rows</span></div>
      <div><strong>{summary.chemicals.matched} / {summary.chemicals.created}</strong><span>Chemicals matched / new</span></div>
      <div><strong>{summary.suppliers.matched} / {summary.suppliers.created}</strong><span>Suppliers matched / new</span></div>
      <div><strong>{summary.locations.matched} / {summary.locations.created}</strong><span>Locations matched / new</span></div>
    </div>
    {rejected.length > 0 && <><h3 className="import-step">Rejected rows</h3><div className="table-wrap"><table><thead><tr><th>ROW</th><th>CHEMICAL</th><th>BOTTLE ID</th><th>ERRORS</th></tr></thead><tbody>{rejected.map(row => <tr key={row.row}><td>{row.row}</td><td>{row.chemical ?? '—'}</td><td className="mono">{row.bottle_id ?? '—'}</td><td className="wrap-cell">{row.errors.join(' ')}</td></tr>)}</tbody></table></div></>}
    {warned.length > 0 && <><h3 className="import-step">Warnings</h3><div className="table-wrap"><table><thead><tr><th>ROW</th><th>CHEMICAL</th><th>WARNING</th></tr></thead><tbody>{warned.map(row => <tr key={row.row}><td>{row.row}</td><td>{row.chemical ?? '—'}</td><td className="wrap-cell">{row.warnings.join(' ')}</td></tr>)}</tbody></table></div></>}
  </div>
}
