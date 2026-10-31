import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { convert } from '../lib/units'

export type Range = '30d' | '3m' | '6m' | '12m'
export type Category = 'CHEMICAL' | 'COMMERCIAL_SOLVENT' | 'NMR_SOLVENT'
export const CATEGORY_LABEL: Record<Category, string> = { CHEMICAL: 'Chemical', COMMERCIAL_SOLVENT: 'Commercial solvent', NMR_SOLVENT: 'NMR solvent' }
export type Bottle = {
  id: string; bottle_id: string; chemical_id: string; chemical: string; cas: string | null; formula: string | null; category: Category
  /** Remaining quantity; 0 when not verified yet (see `known`). */
  quantity: number; known: boolean; unit: string | null; initial: number | null; size: number | null; sizeUnit: string | null
  totalUsed: number; untracked: number; threshold: number | null; thresholdUnit: string | null
  lastUsedBy: string | null; lastUsedAt: string | null; lastUsedQty: number | null; legacyLastUsedBy: string | null
  manufacturer: string | null; supplier: string; location: string; place: string | null; tray: string | null; expiry: string | null; status: string; notes: string | null; batch: string | null
}
export const initialOf = (b: Bottle) => (b.initial != null && b.initial > 0 ? { value: b.initial, unit: b.unit } : b.size != null && b.size > 0 ? { value: b.size, unit: b.sizeUnit } : null)
/** Percent of the initial quantity left (initial = recorded initial quantity, else bottle size); null if not comparable or not verified. */
export function percentLeft(b: Bottle) {
  if (!b.known) return null
  const initial = initialOf(b)
  const base = initial ? convert(initial.value, initial.unit, b.unit) : NaN
  return Number.isFinite(base) && base > 0 && Number.isFinite(b.quantity) ? b.quantity / base * 100 : null
}
/** Low-stock level in the bottle's unit: its own threshold when the Admin set one, else 20% of the initial quantity (system default). */
export function lowLimit(b: Bottle): { value: number; source: 'threshold' | 'default' } | null {
  if (b.threshold != null && b.threshold > 0) { const value = convert(b.threshold, b.thresholdUnit ?? b.unit, b.unit); return Number.isFinite(value) ? { value, source: 'threshold' } : null }
  const initial = initialOf(b); const base = initial ? convert(initial.value, initial.unit, b.unit) : NaN
  return Number.isFinite(base) && base > 0 ? { value: 0.2 * base, source: 'default' } : null
}
/** Shared low-stock rule (same as the database's labventory_low_limit). Unverified bottles are never "low". */
export const isLowQuantity = (b: Bottle) => { const limit = lowLimit(b); return b.known && limit !== null && b.quantity < limit.value }
export const round = (value: number) => Number(value.toFixed(4))
export const qty = (value: number | null | undefined, unit: string | null | undefined) => (value == null ? '—' : `${round(value)} ${unit ?? ''}`.trim())
export const remainingText = (b: Bottle) => (b.known ? qty(b.quantity, b.unit) : 'Not yet checked')

/** A chemical from a particular make (within one inventory tab). The same CAS from two makes is two separate items here. */
export type ChemicalGroup = { key: string; chemical_id: string; category: Category; name: string; cas: string | null; make: string | null; bottles: Bottle[]; low: Bottle[] }
export const groupKey = (b: { chemical_id: string; manufacturer: string | null; category?: Category }) => `${b.category ?? 'CHEMICAL'}|${b.chemical_id}|${(b.manufacturer ?? '').trim().toLowerCase()}`
/** "1 of 3 bottles is low" style summary for a group with at least one low bottle. */
export function lowSummary(group: ChemicalGroup) {
  const n = group.low.length, total = group.bottles.length
  if (!n) return ''
  return total === 1 ? 'This bottle is below its low-stock level' : `${n} of ${total} bottles ${n === 1 ? 'is' : 'are'} low or empty`
}
/** Totals per unit (never mixing mass and volume), plus how many bottles have no verified amount yet. */
export function groupTotal(bottles: Bottle[]) {
  const sums = new Map<string, number>(); let unknown = 0
  for (const b of bottles) { if (!b.known) { unknown++; continue } const unit = b.unit ?? 'no unit'; sums.set(unit, (sums.get(unit) ?? 0) + b.quantity) }
  const text = [...sums].map(([unit, sum]) => `${round(sum)} ${unit}`).join(' + ')
  return { text, unknown, label: [text, unknown ? `${unknown} bottle${unknown > 1 ? 's' : ''} not yet checked` : ''].filter(Boolean).join(' + ') || '—' }
}

export type Chemical = { id: string; name: string; cas: string | null; formula: string | null; hazardous: boolean; state: string | null; storage: string | null }
export type Usage = {
  id: string; created_at: string; quantity_change: number; quantity_unit: string | null; user_id: string; user_name: string | null; user_email: string | null
  purpose: string | null; experiment: string | null; notes: string | null; chemical: string; cas: string | null; make: string | null; bottle_id: string; bottle_code: string; category: Category
  quantity_before: number; quantity_after: number; recorded: number; corrections: number; last_corrected_at: string | null
}
export type Person = { id: string; name: string; email: string | null }

type InventoryContextValue = {
  bottles: Bottle[]; chemicals: Chemical[]; groups: ChemicalGroup[]; groupOf: Map<string, ChemicalGroup>; usage: Usage[]; people: Map<string, string>; directory: Map<string, Person>; range: Range; setRange: (range: Range) => void
  loading: boolean; usageLoading: boolean; error: string; realtime: 'connecting' | 'live' | 'offline'; lastLoaded: Date | null
  refresh: () => Promise<void>
}
const InventoryContext = createContext<InventoryContextValue | null>(null)
const PAGE = 1000 // PostgREST's default max-rows; page so large inventories are not silently truncated.

export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) return rows
  }
}
const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value) ?? null

export function startFor(range: Range) { const date = new Date(); if (range === '30d') date.setDate(date.getDate() - 30); else date.setMonth(date.getMonth() - (range === '3m' ? 3 : range === '6m' ? 6 : 12)); return date }

async function loadBottles(): Promise<Bottle[]> {
  const rows = await fetchAll<any>((from, to) => supabase.from('bottles').select('id,bottle_id,chemical_id,inventory_category,current_quantity,initial_quantity,bottle_size,bottle_size_unit,quantity_unit,total_used,untracked_quantity,low_stock_threshold,low_stock_threshold_unit,last_used_by,last_used_at,last_used_quantity,legacy_last_used_by,manufacturer,expiry_date,status,notes,batch_lot_number,chemicals(name,cas_number,molecular_formula),suppliers(vendor_name),locations(room,cabinet,shelf,tray)').eq('is_archived', false).order('bottle_id').range(from, to))
  const n = (value: unknown) => (value == null ? null : Number(value))
  return rows.map(row => {
    const chemical = one<any>(row.chemicals), supplier = one<any>(row.suppliers), location = one<any>(row.locations)
    return {
      id: row.id, bottle_id: row.bottle_id, chemical_id: row.chemical_id, chemical: chemical?.name ?? 'Unnamed chemical', cas: chemical?.cas_number ?? null, formula: chemical?.molecular_formula ?? null,
      category: (row.inventory_category ?? 'CHEMICAL') as Category,
      quantity: Number(row.current_quantity ?? 0), known: row.current_quantity != null, unit: row.quantity_unit, initial: n(row.initial_quantity), size: n(row.bottle_size), sizeUnit: row.bottle_size_unit,
      totalUsed: Number(row.total_used ?? 0), untracked: Number(row.untracked_quantity ?? 0), threshold: n(row.low_stock_threshold), thresholdUnit: row.low_stock_threshold_unit,
      lastUsedBy: row.last_used_by, lastUsedAt: row.last_used_at, lastUsedQty: n(row.last_used_quantity), legacyLastUsedBy: row.legacy_last_used_by,
      manufacturer: row.manufacturer, supplier: supplier?.vendor_name ?? 'Unknown supplier',
      location: [location?.room, location?.cabinet, location?.shelf, location?.tray].filter(Boolean).join(' / ') || 'Location unavailable', place: location?.room ?? null, tray: location?.tray ?? null, expiry: row.expiry_date, status: row.status,
      notes: row.notes, batch: row.batch_lot_number,
    }
  })
}
async function loadChemicals(): Promise<Chemical[]> {
  const rows = await fetchAll<any>((from, to) => supabase.from('chemicals').select('id,name,cas_number,molecular_formula,is_hazardous,physical_state,storage_temperature').eq('is_archived', false).order('name').range(from, to))
  return rows.map(row => ({ id: row.id, name: row.name, cas: row.cas_number, formula: row.molecular_formula, hazardous: row.is_hazardous, state: row.physical_state, storage: row.storage_temperature }))
}
export const toUsage = (row: any): Usage => ({
  id: row.id, created_at: row.created_at, quantity_change: -Number(row.quantity), quantity_unit: row.quantity_unit, user_id: row.user_id, user_name: row.user_name, user_email: row.user_email,
  purpose: row.purpose, experiment: row.experiment, notes: row.notes, chemical: row.chemical ?? 'Unnamed chemical', cas: row.cas, make: row.manufacturer, bottle_id: row.bottle_id, bottle_code: row.bottle_code,
  category: row.category, quantity_before: Number(row.quantity_before), quantity_after: Number(row.quantity_after), recorded: Number(row.recorded_quantity), corrections: row.correction_count ?? 0, last_corrected_at: row.last_corrected_at,
})
/** Usage entries (usage_history view) with their current, corrected quantities; quantity_change is negative. */
export async function loadUsageSince(since: Date | null): Promise<Usage[]> {
  const rows = await fetchAll<any>((from, to) => { let query = supabase.from('usage_history').select('*'); if (since) query = query.gte('created_at', since.toISOString()); return query.order('created_at', { ascending: true }).order('id').range(from, to) })
  return rows.map(toUsage)
}
const loadUsage = (range: Range) => loadUsageSince(startFor(range))
async function loadPeople(): Promise<Map<string, Person>> {
  // people_directory: names and emails of everyone, readable by any active user (profiles itself stays private).
  const { data, error } = await supabase.from('people_directory').select('id,full_name,email')
  if (error) throw new Error(error.message)
  return new Map((data ?? []).map((row: any) => [row.id, { id: row.id, name: row.full_name || row.email, email: row.email }]))
}

export function InventoryProvider({ children }: { children: ReactNode }) {
  const [bottles, setBottles] = useState<Bottle[]>([]); const [chemicals, setChemicals] = useState<Chemical[]>([]); const [usage, setUsage] = useState<Usage[]>([]); const [directory, setDirectory] = useState<Map<string, Person>>(new Map())
  const [range, setRange] = useState<Range>('6m'); const [loading, setLoading] = useState(true); const [usageLoading, setUsageLoading] = useState(true)
  const [error, setError] = useState(''); const [realtime, setRealtime] = useState<InventoryContextValue['realtime']>('connecting'); const [lastLoaded, setLastLoaded] = useState<Date | null>(null)
  const rangeRef = useRef(range); rangeRef.current = range
  const generation = useRef(0)

  const refreshUsage = useCallback(async () => {
    const current = generation.current
    setUsageLoading(true)
    try { const rows = await loadUsage(rangeRef.current); if (current === generation.current) setUsage(rows) }
    catch (loadError) { if (current === generation.current) setError(loadError instanceof Error ? loadError.message : 'Unable to load usage.') }
    finally { if (current === generation.current) setUsageLoading(false) }
  }, [])
  const refresh = useCallback(async () => {
    const current = ++generation.current
    setError('')
    try {
      const [nextBottles, nextChemicals, nextUsage, nextPeople] = await Promise.all([loadBottles(), loadChemicals(), loadUsage(rangeRef.current), loadPeople()])
      if (current !== generation.current) return
      setBottles(nextBottles); setChemicals(nextChemicals); setUsage(nextUsage); setDirectory(nextPeople); setLastLoaded(new Date())
    } catch (loadError) { if (current === generation.current) setError(loadError instanceof Error ? loadError.message : 'Unable to load inventory.') }
    finally { if (current === generation.current) { setLoading(false); setUsageLoading(false) } }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  const firstRange = useRef(true)
  useEffect(() => { if (firstRange.current) { firstRange.current = false; return } void refreshUsage() }, [range, refreshUsage])

  useEffect(() => {
    // Realtime is a hint to refetch, never a source of row data, so RLS-filtered queries stay authoritative.
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 400) }
    const channel = supabase.channel('inventory-sync')
    for (const table of ['bottles', 'chemicals', 'suppliers', 'locations', 'transactions', 'transaction_corrections']) channel.on('postgres_changes', { event: '*', schema: 'public', table }, schedule)
    channel.subscribe(status => setRealtime(status === 'SUBSCRIBED' ? 'live' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED' ? 'offline' : 'connecting'))
    // Fallback when Realtime is unavailable or events were missed while the tab was hidden.
    const onVisible = () => { if (document.visibilityState === 'visible') schedule() }
    document.addEventListener('visibilitychange', onVisible); window.addEventListener('online', schedule)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', schedule); void supabase.removeChannel(channel) }
  }, [refresh])

  const { groups, groupOf } = useMemo(() => {
    const map = new Map<string, ChemicalGroup>()
    for (const b of bottles) {
      const key = groupKey(b); let g = map.get(key)
      if (!g) { g = { key, chemical_id: b.chemical_id, category: b.category, name: b.chemical, cas: b.cas, make: b.manufacturer?.trim() || null, bottles: [], low: [] }; map.set(key, g) }
      g.bottles.push(b); if (isLowQuantity(b) || (b.known && b.quantity <= 0)) g.low.push(b)
    }
    // Chemicals with no bottles at all still appear once in the chemical register (not solvent-only records).
    const withBottles = new Set(bottles.map(b => b.chemical_id))
    for (const c of chemicals) if (!withBottles.has(c.id)) map.set(`CHEMICAL|${c.id}|`, { key: `CHEMICAL|${c.id}|`, chemical_id: c.id, category: 'CHEMICAL', name: c.name, cas: c.cas, make: null, bottles: [], low: [] })
    const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.make ?? '').localeCompare(b.make ?? ''))
    return { groups: list, groupOf: map }
  }, [bottles, chemicals])
  const people = useMemo(() => new Map([...directory].map(([id, person]) => [id, person.name])), [directory])
  return <InventoryContext.Provider value={{ bottles, chemicals, groups, groupOf, usage, people, directory, range, setRange, loading, usageLoading, error, realtime, lastLoaded, refresh }}>{children}</InventoryContext.Provider>
}
export function useInventory() {
  const value = useContext(InventoryContext)
  if (!value) throw new Error('useInventory must be used inside InventoryProvider')
  return value
}
