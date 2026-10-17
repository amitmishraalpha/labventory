import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'

export type Range = '30d' | '3m' | '6m' | '12m'
export type Bottle = {
  id: string; bottle_id: string; chemical_id: string; chemical: string; cas: string | null; formula: string | null
  quantity: number; unit: string | null; initial: number | null; size: number | null; sizeUnit: string | null
  manufacturer: string | null; supplier: string; location: string; expiry: string | null; status: string
}
export type Chemical = { id: string; name: string; cas: string | null; formula: string | null; hazardous: boolean; state: string | null; storage: string | null }
export type Usage = { created_at: string; quantity_change: number; quantity_unit: string | null }

type InventoryContextValue = {
  bottles: Bottle[]; chemicals: Chemical[]; usage: Usage[]; range: Range; setRange: (range: Range) => void
  loading: boolean; usageLoading: boolean; error: string; realtime: 'connecting' | 'live' | 'offline'; lastLoaded: Date | null
  refresh: () => Promise<void>
}
const InventoryContext = createContext<InventoryContextValue | null>(null)
const PAGE = 1000 // PostgREST's default max-rows; page so large inventories are not silently truncated.

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
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
  const rows = await fetchAll<any>((from, to) => supabase.from('bottles').select('id,bottle_id,chemical_id,current_quantity,initial_quantity,bottle_size,bottle_size_unit,quantity_unit,manufacturer,expiry_date,status,chemicals(name,cas_number,molecular_formula),suppliers(vendor_name),locations(room,cabinet,shelf,tray)').eq('is_archived', false).order('bottle_id').range(from, to))
  return rows.map(row => {
    const chemical = one<any>(row.chemicals), supplier = one<any>(row.suppliers), location = one<any>(row.locations)
    return {
      id: row.id, bottle_id: row.bottle_id, chemical_id: row.chemical_id, chemical: chemical?.name ?? 'Unnamed chemical', cas: chemical?.cas_number ?? null, formula: chemical?.molecular_formula ?? null,
      quantity: Number(row.current_quantity), unit: row.quantity_unit, initial: row.initial_quantity == null ? null : Number(row.initial_quantity), size: row.bottle_size == null ? null : Number(row.bottle_size), sizeUnit: row.bottle_size_unit,
      manufacturer: row.manufacturer, supplier: supplier?.vendor_name ?? 'Unknown supplier',
      location: [location?.room, location?.cabinet, location?.shelf, location?.tray].filter(Boolean).join(' / ') || 'Location unavailable', expiry: row.expiry_date, status: row.status,
    }
  })
}
async function loadChemicals(): Promise<Chemical[]> {
  const rows = await fetchAll<any>((from, to) => supabase.from('chemicals').select('id,name,cas_number,molecular_formula,is_hazardous,physical_state,storage_temperature').eq('is_archived', false).order('name').range(from, to))
  return rows.map(row => ({ id: row.id, name: row.name, cas: row.cas_number, formula: row.molecular_formula, hazardous: row.is_hazardous, state: row.physical_state, storage: row.storage_temperature }))
}
async function loadUsage(range: Range): Promise<Usage[]> {
  // Only genuine USAGE transactions; STOCK_IN rows from imports are excluded by design.
  const rows = await fetchAll<any>((from, to) => supabase.from('transactions').select('created_at,quantity_change,bottles(quantity_unit)').eq('transaction_type', 'USAGE').gte('created_at', startFor(range).toISOString()).order('created_at', { ascending: true }).range(from, to))
  return rows.map(row => ({ created_at: row.created_at, quantity_change: Number(row.quantity_change), quantity_unit: one<any>(row.bottles)?.quantity_unit ?? null }))
}

export function InventoryProvider({ children }: { children: ReactNode }) {
  const [bottles, setBottles] = useState<Bottle[]>([]); const [chemicals, setChemicals] = useState<Chemical[]>([]); const [usage, setUsage] = useState<Usage[]>([])
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
      const [nextBottles, nextChemicals, nextUsage] = await Promise.all([loadBottles(), loadChemicals(), loadUsage(rangeRef.current)])
      if (current !== generation.current) return
      setBottles(nextBottles); setChemicals(nextChemicals); setUsage(nextUsage); setLastLoaded(new Date())
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
    for (const table of ['bottles', 'chemicals', 'suppliers', 'locations', 'transactions']) channel.on('postgres_changes', { event: '*', schema: 'public', table }, schedule)
    channel.subscribe(status => setRealtime(status === 'SUBSCRIBED' ? 'live' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED' ? 'offline' : 'connecting'))
    // Fallback when Realtime is unavailable or events were missed while the tab was hidden.
    const onVisible = () => { if (document.visibilityState === 'visible') schedule() }
    document.addEventListener('visibilitychange', onVisible); window.addEventListener('online', schedule)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', schedule); void supabase.removeChannel(channel) }
  }, [refresh])

  return <InventoryContext.Provider value={{ bottles, chemicals, usage, range, setRange, loading, usageLoading, error, realtime, lastLoaded, refresh }}>{children}</InventoryContext.Provider>
}
export function useInventory() {
  const value = useContext(InventoryContext)
  if (!value) throw new Error('useInventory must be used inside InventoryProvider')
  return value
}
