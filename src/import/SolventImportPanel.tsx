import { useRef, useState, type ChangeEvent } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, ShieldCheck } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { explainError } from '../lib/errors'
import { gridFromWorkbook, parseSolventGrid, type SolventSheet } from './solventSheet'
import { sha256 } from './spreadsheet'

type RowResult = { row: number; part: string | null; bottle_id: string; name: string; category: string; status: 'valid' | 'imported' | 'existing' | 'error'; quantity: number | null; unit: string | null; errors: string[]; warnings: string[] }
type Result = { dry_run: boolean; new: number; existing: number; errors: number; needs_review: number; rows: RowResult[]; already_imported?: boolean; imported_at?: string }
const SECTION: Record<string, string> = { COMMERCIAL_SOLVENT: 'Commercial', NMR_SOLVENT: 'NMR' }

/** Admin import of the Commercial / NMR solvent sheet: preview -> server check (dry run) -> confirm. */
export default function SolventImportPanel({ onImported }: { onImported: () => Promise<void> | void }) {
  const [file, setFile] = useState<{ name: string; sha: string; sheet: SolventSheet } | null>(null); const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const key = useRef<string | null>(null); const inFlight = useRef(false); const input = useRef<HTMLInputElement>(null)
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0]; if (!chosen) return
    setFile(null); setResult(null); setError(''); key.current = null
    try {
      if (!/\.xlsx$/i.test(chosen.name)) throw new Error('Choose the .xlsx file.')
      const buffer = await chosen.arrayBuffer()
      const sheet = parseSolventGrid(gridFromWorkbook(buffer))
      if (!sheet.rows.length) throw new Error('No solvent rows were found under the section titles.')
      setFile({ name: chosen.name, sha: await sha256(buffer), sheet })
    } catch (readError) { setError(readError instanceof Error ? readError.message : 'The file could not be read.') }
  }
  const call = async (dryRun: boolean) => {
    if (!file || inFlight.current) return
    inFlight.current = true; setBusy(dryRun ? 'Checking...' : 'Importing...'); setError('')
    if (!key.current) key.current = crypto.randomUUID()
    const { data, error: rpcError } = await supabase.rpc('import_solvent_batch', { p_idempotency_key: key.current, p_file_name: file.name, p_file_sha256: file.sha, p_rows: file.sheet.rows, p_dry_run: dryRun })
    inFlight.current = false; setBusy('')
    if (rpcError) { setError(`${await explainError(rpcError, 'The import failed.')} Nothing was saved.`); return }
    setResult(data as Result)
    if (!dryRun) await onImported()
  }
  const rows = result?.rows ?? null
  return <section className="panel admin-section import-panel"><h2>Import solvents</h2><p>Reads the solvent sheet with a <b>Commercial Solvents</b> block and a <b>D Solvents</b> block (NMR). Each can or bottle becomes its own record. Original values are kept; nothing is imported until you confirm.</p>
    <div className="import-notes"><div><ShieldCheck size={15}/><span>Amounts are never assumed: a can with no “Available Qty” is marked <b>Needs review</b> and the Admin enters the counted amount before anyone can record usage.</span></div><div><AlertTriangle size={15}/><span>“Last used by” values from the sheet are kept as legacy notes, separate from real usage history.</span></div></div>
    <label className="secondary file-button"><FileSpreadsheet size={16}/> Choose .xlsx file<input ref={input} type="file" accept=".xlsx" onChange={event => void choose(event)} hidden/></label>
    {error && <div className="user-error">{error}</div>}
    {file && <>
      <p className="muted-note"><b>{file.name}</b>: {file.sheet.sections.map(s => `${s.title} (${s.sourceRows} rows)`).join(', ')} → {file.sheet.rows.length} cans/bottles.</p>
      {file.sheet.problems.map(problem => <div key={problem} className="info-note warn">{problem}</div>)}
      <div className="table-wrap"><table className="cards compact-table"><thead><tr><th>ROW</th><th>TAB</th><th>NAME</th><th>BOTTLE ID</th><th>PACK</th><th>AVAILABLE</th><th>MAKE</th><th>LOCATION</th><th>CHECK</th></tr></thead><tbody>
        {file.sheet.rows.map((row, index) => { const server = rows?.[index]; return <tr key={`${row.bottle_id}-${index}`} className={server?.status === 'error' ? 'low-row' : ''}>
          <td>{row.row}{row.part && <small className="cell-note">{row.part}</small>}</td><td>{SECTION[row.category]}</td><td><b>{row.name}</b></td>
          <td className="mono">{row.bottle_id}{row.generated_id && <small className="cell-note pending-note">assigned</small>}</td><td>{row.raw.pack_size || '—'}</td>
          <td>{server ? (server.quantity == null ? <span className="pending-note">Needs review</span> : `${server.quantity} ${server.unit ?? ''}`) : row.quantity ? `${row.quantity} ${row.quantity_unit}` : <span className="pending-note">Not given</span>}</td>
          <td>{row.make || '—'}</td><td>{row.place || <span className="pending-note">Missing</span>}</td>
          <td className="wrap-cell">{server ? <><b className={server.status === 'error' ? 'low-note' : ''}>{server.status === 'valid' ? 'Ready' : server.status === 'existing' ? 'Already imported (skipped)' : server.status === 'imported' ? 'Imported' : 'Error'}</b>{[...server.errors, ...server.warnings].map(text => <small key={text} className="cell-note">{text}</small>)}</> : row.flag ? <small className="cell-note">{row.flag}</small> : <span className="muted">Not checked yet</span>}</td>
        </tr> })}
      </tbody></table></div>
      {result?.already_imported ? <div className="admin-success"><CheckCircle2 size={15}/> This file was already imported{result.imported_at ? ` on ${new Date(result.imported_at).toLocaleString()}` : ''}. Nothing was added.</div>
      : result && !result.dry_run ? <div className="admin-success"><CheckCircle2 size={15}/> Imported {result.new} cans/bottles{result.existing ? `; ${result.existing} already existed and were skipped` : ''}. {result.needs_review} need their amount checked (Commercial / NMR Solvents tabs → Enter amount).</div>
      : result ? <div className={result.errors ? 'user-error' : 'info-note'}>{result.errors ? `${result.errors} row(s) have errors and must be fixed in the file; nothing can be imported yet.` : `Ready: ${result.new} new, ${result.existing} already imported, ${result.needs_review} without a checked amount (Needs review).`}</div> : null}
      <div className="export-actions">{(!result || !result.dry_run) && !result?.already_imported && !(result && !result.dry_run) && <button className="primary" disabled={Boolean(busy)} onClick={() => void call(true)}>{busy || 'Check with the database'}</button>}
        {result?.dry_run && !result.errors && result.new > 0 && <button className="primary" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Import ${result.new} cans/bottles into the solvent tabs?`)) void call(false) }}>{busy || `Import ${result.new} cans/bottles`}</button>}
        {result?.dry_run && <button className="secondary" disabled={Boolean(busy)} onClick={() => void call(true)}>Check again</button>}
        <button className="secondary" onClick={() => { setFile(null); setResult(null); setError(''); key.current = null; if (input.current) input.current.value = '' }}>Choose another file</button></div>
    </>}
  </section>
}
