import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Search, ShoppingCart } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { CATEGORY_LABEL, isLowQuantity, lowLimit, qty, remainingText, round, useInventory, type Bottle, type Category } from '../data/InventoryProvider'
import { ExportMenu, LastUsed, Pager, StatusBadge, usePaged } from '../components/TableTools'
import { fmtDateTime, type ExportColumn } from '../lib/exporter'
import { matchesChemical } from '../lib/search'
import PubChemLink from '../lib/PubChemLink'

export const isLowOrEmpty = (b: Bottle) => b.known && (isLowQuantity(b) || b.quantity <= 0)
const shortfall = (b: Bottle) => { const limit = lowLimit(b); return limit ? Math.max(limit.value - b.quantity, 0) : null }

export function orderPrefillFor(b: Bottle) {
  return { chemical_name: b.chemical, cas_number: b.cas ?? '', category: b.category, quantity_unit: b.sizeUnit ?? b.unit ?? '', requested_quantity: b.size ? String(b.size) : '', preferred_pack_size: b.size ? `${round(b.size)} ${b.sizeUnit ?? ''}`.trim() : '', preferred_supplier: b.manufacturer ?? '', chemical_id: b.chemical_id, source_bottle_id: b.id, reason: `Low stock: ${remainingText(b)} left in ${b.bottle_id}` }
}

export default function LowStockPage() {
  const { profile } = useAuth(); const { bottles, people, loading, error } = useInventory(); const navigate = useNavigate()
  const [query, setQuery] = useState(''); const [category, setCategory] = useState<'' | Category>('')
  const low = useMemo(() => bottles.filter(isLowOrEmpty).sort((a, b) => a.quantity / (lowLimit(a)?.value || 1) - b.quantity / (lowLimit(b)?.value || 1)), [bottles])
  const filtered = useMemo(() => low.filter(b => (!category || b.category === category) && matchesChemical(query, b.chemical, b.cas, b.bottle_id, b.manufacturer, b.place, b.tray)), [low, category, query])
  const paged = usePaged(filtered)
  const defaults = low.filter(b => lowLimit(b)?.source === 'default').length
  const columns: ExportColumn<Bottle>[] = [
    { header: 'Chemical / solvent name', value: b => b.chemical }, { header: 'CAS No', value: b => b.cas }, { header: 'Inventory', value: b => CATEGORY_LABEL[b.category] }, { header: 'Bottle ID', value: b => b.bottle_id },
    { header: 'Manufacturer', value: b => b.manufacturer }, { header: 'Location', value: b => [b.place, b.tray].filter(Boolean).join(' / ') }, { header: 'Current quantity', value: b => round(b.quantity) }, { header: 'Unit', value: b => b.unit },
    { header: 'Low-stock threshold', value: b => { const limit = lowLimit(b); return limit ? round(limit.value) : '' } }, { header: 'Threshold source', value: b => (lowLimit(b)?.source === 'threshold' ? 'Set for this bottle' : 'System default: 20% of initial') },
    { header: 'Shortfall', value: b => { const s = shortfall(b); return s == null ? '' : round(s) } }, { header: 'Last used by', value: b => (b.lastUsedBy ? people.get(b.lastUsedBy) ?? 'Unknown user' : 'Never used') },
    { header: 'Last used at', value: b => fmtDateTime(b.lastUsedAt) }, { header: 'Status', value: b => (b.quantity <= 0 ? 'Depleted' : 'Low Stock') },
  ]
  return <><div className="title-row"><div><p className="eyebrow">ALL INVENTORIES</p><h1>Low stock</h1><p className="subtitle">Bottles and cans below their low-stock threshold, or empty. Bottles whose amount has not been checked are not included.</p></div></div>
    {error && <div className="user-error">{error}</div>}
    {profile?.role === 'ADMIN' && defaults > 0 && <div className="info-note"><AlertTriangle size={15}/> {defaults} of these use the system default (below 20% of the initial quantity) because no threshold is set for them. Set a threshold with Edit on the bottle.</div>}
    <section className="panel table-panel"><div className="inventory-toolbar wrap-toolbar"><div className="search"><Search size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name, CAS, Bottle ID, make or place..."/></div>
      <select className="analytics-select" value={category} onChange={event => setCategory(event.target.value as '' | Category)} aria-label="Inventory"><option value="">All inventories</option>{(Object.keys(CATEGORY_LABEL) as Category[]).map(value => <option key={value} value={value}>{CATEGORY_LABEL[value]}s</option>)}</select>
      <ExportMenu baseName="low-stock" title="Low-stock inventory" columns={columns} scopes={[{ key: 'matching', label: 'All matching low-stock items', rows: filtered }, { key: 'page', label: 'Current page', rows: paged.visible }, { key: 'all', label: 'All low-stock items', rows: low }]}/></div>
      <div className="table-wrap"><table className="cards"><thead><tr><th>NAME</th><th>INVENTORY</th><th>BOTTLE ID</th><th>MAKE</th><th>LOCATION</th><th>CURRENT</th><th>THRESHOLD</th><th>SHORTFALL</th><th>LAST USED BY</th><th>STATUS</th><th></th></tr></thead><tbody>
        {loading && !bottles.length ? <tr><td colSpan={11}><div className="loading-row">Loading...</div></td></tr> : paged.visible.map(b => { const limit = lowLimit(b); const s = shortfall(b); return <tr key={b.id}>
          <td><div className="chemical"><b>{b.chemical}</b><PubChemLink name={b.chemical} cas={b.cas}/></div>{b.cas && <small className="cell-note mono">{b.cas}</small>}</td><td>{CATEGORY_LABEL[b.category]}</td><td className="mono">{b.bottle_id}</td><td>{b.manufacturer ?? '—'}</td>
          <td>{[b.place, b.tray].filter(Boolean).join(' / ') || '—'}</td><td><b>{qty(b.quantity, b.unit)}</b></td><td>{limit ? qty(limit.value, b.unit) : '—'}{limit?.source === 'default' && <small className="cell-note">default 20%</small>}</td>
          <td><b className="low-note">{s == null ? '—' : qty(s, b.unit)}</b></td><td><LastUsed bottle={b} compact/></td><td><StatusBadge status={b.quantity <= 0 ? 'Depleted' : 'Low Stock'}/></td>
          <td><button className="table-action" onClick={() => navigate('/orders', { state: { prefill: orderPrefillFor(b) } })}><ShoppingCart size={12}/> Add to order list</button></td></tr> })}
        {!loading && !filtered.length && <tr><td colSpan={11}><div className="empty-users">{low.length ? 'No low-stock items match the search.' : 'Nothing is low on stock right now.'}</div></td></tr>}
      </tbody></table></div><Pager {...paged} total={filtered.length} noun="items"/></section></>
}
