import { Fragment, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDownToLine, ChevronDown, ChevronRight, ClipboardList, History, PencilLine, Plus, Scale, Search, ShoppingCart } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { CATEGORY_LABEL, groupTotal, isLowQuantity, lowLimit, qty, remainingText, round, useInventory, type Bottle, type Category, type ChemicalGroup } from '../data/InventoryProvider'
import { ExportMenu, LastUsed, Pager, StatusBadge, bottleStatus, usePaged } from '../components/TableTools'
import { fmtDateTime, type ExportColumn } from '../lib/exporter'
import { matchesChemical } from '../lib/search'
import RecordUsageModal from '../usage/RecordUsageModal'
import { BottleHistoryModal } from '../usage/UsageHistory'
import { AddItemModal, EditBottleModal, StockCountModal } from '../inventory/AdminBottleModals'
import PubChemLink from '../lib/PubChemLink'
import { orderPrefillFor } from '../lowstock/LowStockPage'

const COPY: Record<Exclude<Category, 'CHEMICAL'>, { title: string; container: string; containers: string; intro: string; file: string }> = {
  COMMERCIAL_SOLVENT: { title: 'Commercial Solvents', container: 'can', containers: 'cans', intro: 'Bulk solvent cans. Each can is tracked separately; the amount left is calculated from recorded usage.', file: 'commercial-solvents' },
  NMR_SOLVENT: { title: 'NMR Solvents', container: 'bottle', containers: 'bottles', intro: 'Deuterated solvents. Each bottle has its own Bottle ID and usage history.', file: 'nmr-solvents' },
}

/** Same people/units rules everywhere: one export row per physical bottle. */
export function bottleColumns(people: Map<string, string>): ExportColumn<Bottle>[] {
  return [
    { header: 'Name', value: b => b.chemical }, { header: 'CAS No', value: b => b.cas }, { header: 'Molecular formula', value: b => b.formula }, { header: 'Inventory', value: b => CATEGORY_LABEL[b.category] },
    { header: 'Bottle ID', value: b => b.bottle_id }, { header: 'Manufacturer', value: b => b.manufacturer }, { header: 'Pack size', value: b => (b.size == null ? '' : round(b.size)) }, { header: 'Pack size unit', value: b => b.sizeUnit },
    { header: 'Initial quantity', value: b => (b.initial == null ? '' : round(b.initial)) }, { header: 'Total consumed', value: b => round(b.totalUsed) }, { header: 'Used before tracking', value: b => (b.untracked ? round(b.untracked) : '') },
    { header: 'Remaining quantity', value: b => (b.known ? round(b.quantity) : 'Not yet checked') }, { header: 'Quantity unit', value: b => b.unit },
    { header: 'Low-stock threshold', value: b => { const limit = lowLimit(b); return limit ? `${round(limit.value)}${limit.source === 'default' ? ' (default 20%)' : ''}` : '' } },
    { header: 'Place', value: b => b.place }, { header: 'Tray No.', value: b => b.tray }, { header: 'Expiry date', value: b => b.expiry }, { header: 'Status', value: b => bottleStatus(b) },
    { header: 'Last used by', value: b => (b.lastUsedBy ? people.get(b.lastUsedBy) ?? 'Unknown user' : b.legacyLastUsedBy ? `${b.legacyLastUsedBy} (from spreadsheet, no date)` : 'Never used') },
    { header: 'Last used at', value: b => fmtDateTime(b.lastUsedAt) }, { header: 'Last quantity used', value: b => (b.lastUsedQty == null ? '' : round(b.lastUsedQty)) },
  ]
}

type Filter = 'all' | 'low' | 'review' | 'empty'
type Sort = 'name' | 'remaining' | 'recent'
const percentOfGroup = (group: ChemicalGroup) => { const known = group.bottles.filter(b => b.known && b.initial); const initial = known.reduce((sum, b) => sum + (b.initial ?? 0), 0); return initial ? known.reduce((sum, b) => sum + b.quantity, 0) / initial : 2 }
const lastUse = (group: ChemicalGroup) => group.bottles.reduce((latest, b) => (b.lastUsedAt && b.lastUsedAt > latest ? b.lastUsedAt : latest), '')

export default function SolventsPage({ category }: { category: Exclude<Category, 'CHEMICAL'> }) {
  const copy = COPY[category]
  const { profile } = useAuth(); const isAdmin = profile?.role === 'ADMIN'; const navigate = useNavigate()
  const { groups, people, loading, error, refresh, usage } = useInventory()
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState<Filter>('all'); const [sort, setSort] = useState<Sort>('name'); const [open, setOpen] = useState<string | null>(null)
  const [action, setAction] = useState<{ kind: 'use' | 'history' | 'edit' | 'count'; bottle: Bottle } | { kind: 'add' } | null>(null); const [notice, setNotice] = useState('')
  const mine = useMemo(() => groups.filter(group => group.category === category && group.bottles.length), [groups, category])
  const filtered = useMemo(() => {
    const list = mine.filter(group => matchesChemical(query, group.name, group.cas, group.make, ...group.bottles.flatMap(b => [b.bottle_id, b.place, b.tray]))
      && (filter === 'all' || (filter === 'low' && group.low.some(b => b.quantity > 0)) || (filter === 'review' && group.bottles.some(b => !b.known)) || (filter === 'empty' && group.bottles.some(b => b.known && b.quantity <= 0))))
    return sort === 'name' ? list : [...list].sort(sort === 'remaining' ? (a, b) => percentOfGroup(a) - percentOfGroup(b) : (a, b) => lastUse(b).localeCompare(lastUse(a)))
  }, [mine, query, filter, sort])
  const paged = usePaged(filtered)
  const bottlesOf = (list: ChemicalGroup[]) => list.flatMap(group => group.bottles)
  const all = bottlesOf(mine)
  const stats = { items: mine.length, bottles: all.length, low: all.filter(isLowQuantity).length, review: all.filter(b => !b.known).length }
  const used = useMemo(() => { const sums = new Map<string, number>(); usage.filter(u => u.category === category).forEach(u => sums.set(u.quantity_unit ?? '', (sums.get(u.quantity_unit ?? '') ?? 0) - u.quantity_change)); return [...sums].map(([unit, sum]) => `${round(sum)} ${unit}`).join(' + ') || '0' }, [usage, category])
  const done = (message: string) => { setAction(null); setNotice(message); void refresh() }
  const orderPrefill = (b: Bottle) => navigate('/orders', { state: { prefill: orderPrefillFor(b) } })
  const columns = bottleColumns(people)

  return <><div className="title-row"><div><p className="eyebrow">INVENTORY · {CATEGORY_LABEL[category].toUpperCase()}S</p><h1>{copy.title}</h1><p className="subtitle">{copy.intro}</p></div>{isAdmin && <button className="primary" onClick={() => setAction({ kind: 'add' })}><Plus size={16}/> Add {copy.container}</button>}</div>
    {error && <div className="user-error">Unable to load inventory: {error}</div>}{notice && <div className="admin-success page-notice">{notice}</div>}
    <section className="stats"><Stat label="Solvents" value={stats.items} detail="Name + make"/><Stat label={`Physical ${copy.containers}`} value={stats.bottles} detail="One record each"/><Stat label="Low stock" value={stats.low} detail="Below threshold or 20% of initial" tone="amber"/><Stat label="Needs review" value={stats.review} detail="Amount not yet checked" tone="red"/></section>
    <p className="muted-note">Recorded usage in the selected dashboard period: <b>{used}</b></p>
    <section className="panel table-panel"><div className="inventory-toolbar wrap-toolbar"><div className="search"><Search size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name, CAS, Bottle ID, make or place..."/></div>
      <select className="analytics-select" value={filter} onChange={event => setFilter(event.target.value as Filter)} aria-label="Filter"><option value="all">All</option><option value="low">Low stock</option><option value="review">Needs review</option><option value="empty">Empty {copy.containers}</option></select>
      <select className="analytics-select" value={sort} onChange={event => setSort(event.target.value as Sort)} aria-label="Sort"><option value="name">Sort: name</option><option value="remaining">Sort: least remaining</option><option value="recent">Sort: recently used</option></select>
      <ExportMenu baseName={copy.file} title={copy.title} columns={columns} scopes={[{ key: 'matching', label: 'All matching results', rows: bottlesOf(filtered) }, { key: 'page', label: 'Current page', rows: bottlesOf(paged.visible) }, { key: 'all', label: `All ${copy.title.toLowerCase()}`, rows: all }]}/></div>
      <div className="table-wrap"><table className="cards"><thead><tr><th>NAME</th><th>MAKE</th><th>{copy.containers.toUpperCase()}</th><th>INITIAL</th><th>CONSUMED</th><th>REMAINING</th><th>STATUS</th><th>LAST USED</th><th></th></tr></thead><tbody>
        {loading && !all.length ? <tr><td colSpan={9}><div className="loading-row">Loading...</div></td></tr> : paged.visible.map(group => {
          const expanded = open === group.key; const total = groupTotal(group.bottles)
          const inUse = group.bottles.filter(b => !b.known || b.quantity > 0).length
          const initial = groupTotal(group.bottles.filter(b => b.initial != null).map(b => ({ ...b, known: true, quantity: b.initial ?? 0 })))
          const consumed = groupTotal(group.bottles.map(b => ({ ...b, known: true, quantity: b.totalUsed })))
          const latest = [...group.bottles].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))[0]
          const status = group.bottles.some(b => !b.known) && !group.bottles.some(b => b.known) ? 'Needs review' : group.low.length ? (group.bottles.every(b => b.known && b.quantity <= 0) ? 'Depleted' : 'Low Stock') : 'Available'
          return <Fragment key={group.key}><tr className="clickable-row" onClick={() => setOpen(expanded ? null : group.key)}>
            <td><div className="chemical"><span className="chem-dot"/><b>{group.name}</b><PubChemLink name={group.name} cas={group.cas}/></div>{group.cas && <small className="cell-note mono">{group.cas}</small>}</td>
            <td>{group.make ?? '—'}</td>
            <td><b>{inUse} of {group.bottles.length}</b><small className="cell-note">{group.bottles.length > 1 ? `${group.bottles.length} ${copy.containers}; totals added up` : `1 ${copy.container}`}</small></td>
            <td>{initial.label}</td><td>{consumed.label}</td>
            <td><b>{total.text || '—'}</b>{total.unknown > 0 && <small className="cell-note pending-note">+ {total.unknown} {total.unknown > 1 ? copy.containers : copy.container} not yet checked</small>}</td>
            <td><StatusBadge status={status}/>{group.low.length > 0 && group.bottles.length > 1 && <small className="cell-note low-note">{group.low.length} of {group.bottles.length} low or empty</small>}</td>
            <td>{latest?.lastUsedAt ? <LastUsed bottle={latest} compact/> : <span className="muted">Never used</span>}</td>
            <td className="chev-cell">{expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</td></tr>
            {expanded && <tr className="detail-row"><td colSpan={9}><table className="nested-table cards"><thead><tr><th>BOTTLE ID</th><th>PACK</th><th>INITIAL</th><th>CONSUMED</th><th>REMAINING</th><th>STATUS</th><th>PLACE</th><th>LAST USED BY</th><th>ACTIONS</th></tr></thead><tbody>{group.bottles.map(b => <tr key={b.id} className={isLowQuantity(b) ? 'low-row' : ''}>
              <td className="mono"><b>{b.bottle_id}</b></td><td>{qty(b.size, b.sizeUnit)}</td><td>{qty(b.initial, b.unit)}</td>
              <td>{qty(b.totalUsed, b.unit)}{b.untracked > 0 && <small className="cell-note">+ {qty(b.untracked, b.unit)} before tracking</small>}</td>
              <td><b>{remainingText(b)}</b>{(() => { const limit = lowLimit(b); return limit && b.known ? <small className="cell-note">Low below {qty(limit.value, b.unit)}{limit.source === 'default' ? ' (default 20%)' : ''}</small> : null })()}</td>
              <td><StatusBadge status={bottleStatus(b)}/></td><td>{[b.place, b.tray].filter(Boolean).join(' / ') || '—'}</td><td><LastUsed bottle={b}/></td>
              <td><div className="user-actions">
                <button className="table-action usage-action" disabled={!b.known || b.quantity <= 0} onClick={() => { setNotice(''); setAction({ kind: 'use', bottle: b }) }} aria-label={`Record usage of ${b.bottle_id}`}><ArrowDownToLine size={12}/> Record usage</button>
                <button className="table-action" onClick={() => setAction({ kind: 'history', bottle: b })} aria-label={`Usage history of ${b.bottle_id}`}><History size={12}/> History</button>
                {isAdmin && <button className="table-action" onClick={() => setAction({ kind: 'count', bottle: b })} aria-label={`Stock count of ${b.bottle_id}`}><Scale size={12}/> {b.known ? 'Stock count' : 'Enter amount'}</button>}
                {isAdmin && <button className="table-action" onClick={() => setAction({ kind: 'edit', bottle: b })} aria-label={`Edit ${b.bottle_id}`}><PencilLine size={12}/> Edit</button>}
                {(isLowQuantity(b) || (b.known && b.quantity <= 0)) && <button className="table-action" onClick={() => orderPrefill(b)}><ShoppingCart size={12}/> Add to order list</button>}
              </div></td></tr>)}</tbody></table></td></tr>}
          </Fragment> })}
        {!loading && !filtered.length && <tr><td colSpan={9}><div className="empty-users">{mine.length ? 'No solvents match the search or filter.' : <>No {copy.title.toLowerCase()} recorded yet.{isAdmin ? <> Add them with “Add {copy.container}”, or import the spreadsheet in Research Management → Import.</> : ''}</>}</div></td></tr>}
      </tbody></table></div><Pager {...paged} total={filtered.length} noun="solvents"/></section>
    <p className="muted-note page-foot"><ClipboardList size={13}/> Remaining = initial − consumed (− amounts used before tracking started). Nobody can type over a remaining amount; it changes only through usage, corrections and Admin stock counts.</p>
    {action?.kind === 'use' && <RecordUsageModal bottle={action.bottle} onClose={() => setAction(null)} onRecorded={done}/>}
    {action?.kind === 'history' && <BottleHistoryModal bottle={action.bottle} onClose={() => setAction(null)} onChanged={() => void refresh()}/>}
    {action?.kind === 'edit' && <EditBottleModal bottle={action.bottle} onClose={() => setAction(null)} onSaved={done}/>}
    {action?.kind === 'count' && <StockCountModal bottle={action.bottle} onClose={() => setAction(null)} onSaved={done}/>}
    {action?.kind === 'add' && <AddItemModal category={category} onClose={() => setAction(null)} onSaved={done}/>}
  </>
}

function Stat({ label, value, detail, tone = 'teal' }: { label: string; value: number; detail: string; tone?: string }) {
  return <div className="stat"><div className={`stat-icon ${tone}`}><ClipboardList size={17}/></div><div><strong>{value}</strong><span>{label}</span><small>{detail}</small></div></div>
}
