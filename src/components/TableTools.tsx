import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { downloadRows, type ExportColumn, type ExportFormat } from '../lib/exporter'
import { useInventory, type Bottle } from '../data/InventoryProvider'
import { fmtDateTime } from '../lib/exporter'

export const PAGE_SIZE = 25

/** Client-side pages over an already filtered list; resets to page 1 when the list changes. */
export function usePaged<T>(rows: T[], size = PAGE_SIZE) {
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(rows.length / size))
  useEffect(() => { setPage(1) }, [rows])
  const current = Math.min(page, pages)
  const visible = useMemo(() => rows.slice((current - 1) * size, current * size), [rows, current, size])
  return { page: current, pages, setPage, visible, from: rows.length ? (current - 1) * size + 1 : 0, to: Math.min(current * size, rows.length) }
}

export function Pager({ page, pages, setPage, from, to, total, noun }: { page: number; pages: number; setPage: (page: number) => void; from: number; to: number; total: number; noun: string }) {
  if (total <= PAGE_SIZE) return <div className="pager"><span className="muted">{total} {noun}</span></div>
  return <div className="pager"><span className="muted">{from}–{to} of {total} {noun}</span><div className="pager-buttons"><button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft size={15}/></button><span>Page {page} of {pages}</span><button className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight size={15}/></button></div></div>
}

type Scope<T> = { key: string; label: string; rows: T[] }
/** Export button with a choice of scope (e.g. all records, all matching results, current page) and format. */
export function ExportMenu<T>({ baseName, title, columns, scopes, label = 'Export' }: { baseName: string; title: string; columns: ExportColumn<T>[]; scopes: Scope<T>[]; label?: string }) {
  const [open, setOpen] = useState(false); const [message, setMessage] = useState(''); const box = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!open) return; const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close) }, [open])
  const run = (scope: Scope<T>, format: ExportFormat) => {
    setOpen(false)
    if (!scope.rows.length) { setMessage('Nothing to export: there are no records in this selection.'); return }
    try { const file = downloadRows(baseName, columns, scope.rows, format, `${title} — ${scope.label}`); setMessage(`Downloaded ${file} (${scope.rows.length} rows).`) }
    catch (error) { setMessage(`Export failed: ${error instanceof Error ? error.message : 'unknown error'}`) }
  }
  return <div className="export-menu" ref={box}><button className="secondary" onClick={() => { setMessage(''); setOpen(!open) }} aria-expanded={open}><Download size={15}/> {label}</button>
    {open && <div className="export-pop" role="menu">{scopes.map(scope => <div key={scope.key} className="export-scope"><b>{scope.label}</b><small>{scope.rows.length} rows</small><div><button className="table-action" role="menuitem" onClick={() => run(scope, 'xlsx')}>Excel</button><button className="table-action" role="menuitem" onClick={() => run(scope, 'csv')}>CSV</button></div></div>)}</div>}
    {message && <small className="export-note" role="status">{message}</small>}</div>
}

/** Last used by / at, from recorded usage only. Legacy spreadsheet values are shown separately and labelled. */
export function LastUsed({ bottle, compact = false }: { bottle: Bottle; compact?: boolean }) {
  const { people } = useInventory()
  if (!bottle.lastUsedAt) return <span className="muted">Never used{bottle.legacyLastUsedBy ? <small className="cell-note">Sheet says: {bottle.legacyLastUsedBy} (no date)</small> : null}</span>
  const who = (bottle.lastUsedBy && people.get(bottle.lastUsedBy)) || 'Unknown user'
  return <span><b>{who}</b><small className="cell-note">{fmtDateTime(bottle.lastUsedAt)}{!compact && bottle.lastUsedQty != null ? ` · ${Number(bottle.lastUsedQty.toFixed(4))} ${bottle.unit ?? ''}` : ''}</small></span>
}

export function StatusBadge({ status }: { status: string }) {
  const tone = /low/i.test(status) ? 'low' : /depleted|rejected|cancelled|disposed|expired/i.test(status) ? 'bad' : /review|requested|pending|partially/i.test(status) ? 'pending' : /ordered|approved/i.test(status) ? 'info' : 'ok'
  return <span className={`status-badge ${tone}`}>{status}</span>
}
/** Display status: "Needs review" for unverified bottles, otherwise the stored status. */
export const bottleStatus = (b: Bottle) => (!b.known && ['Available', 'Low Stock', 'Depleted'].includes(b.status) ? 'Needs review' : b.status)
