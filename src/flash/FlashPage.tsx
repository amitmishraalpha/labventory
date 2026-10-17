import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CalendarDays, CalendarOff, ChevronLeft, ChevronRight, Clock, RefreshCw, Trash2 } from 'lucide-react'
import { getSupabaseErrorMessage, supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'

// Mirrors public.flash_config() in the database, which enforces these rules.
export const FLASH = { tz: 'Asia/Kolkata', offset: '+05:30', open: 9, close: 18, maxSlots: 3, maxDaysAhead: 60 }
type Booking = { id: string; booking_group: string; user_id: string; booked_by_name: string; slot_start: string; slot_end: string; purpose: string | null }
type Holiday = { holiday_date: string; name: string; source: 'google' | 'admin' }
type Group = { group: string; user_id: string; who: string; start: Date; end: Date; slots: number; purpose: string | null }

const pad = (n: number) => String(n).padStart(2, '0')
const labDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: FLASH.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const labTime = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: FLASH.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
const slotStart = (date: string, hour: number) => new Date(`${date}T${pad(hour)}:00:00${FLASH.offset}`)
const addDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const dayLabel = (date: string, opts: Intl.DateTimeFormatOptions) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' })
const HOURS = Array.from({ length: FLASH.close - FLASH.open }, (_, i) => FLASH.open + i)

function explain(message: string) {
  if (message.includes('Could not find the function public.book_flash_slots') || message.includes("Could not find the table 'public.flash_bookings'")) return 'Flash booking is not installed in Supabase yet. Apply migration 20261018180000_flash_chromatography.sql.'
  const known = message.match(/^(SLOT_TAKEN|HOLIDAY|OUTSIDE_LAB_HOURS|SLOT_IN_PAST|TOO_FAR_AHEAD|INVALID_DURATION|NOT_YOUR_BOOKING|ALREADY_STARTED): (.*)$/)
  if (known) return known[2].charAt(0).toUpperCase() + known[2].slice(1) + '.'
  if (message.includes('ACCOUNT_NOT_ACTIVE')) return 'Your account is not active.'
  return message
}

export default function FlashPage() {
  const { profile } = useAuth(); const isAdmin = profile?.role === 'ADMIN'
  const today = labDate(new Date())
  const [day, setDay] = useState(today); const [month, setMonth] = useState(today.slice(0, 7))
  const [bookings, setBookings] = useState<Booking[]>([]); const [holidays, setHolidays] = useState<Holiday[]>([])
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
  const [start, setStart] = useState<number | null>(null); const [slots, setSlots] = useState(1); const [purpose, setPurpose] = useState(''); const [busy, setBusy] = useState(false)
  const inFlight = useRef(false); const [now, setNow] = useState(() => new Date())

  const load = useCallback(async () => {
    const monthStart = `${month}-01`, monthEnd = addDays(addDays(monthStart, 31).slice(0, 7) + '-01', 0)
    const from = [monthStart, today].sort()[0], to = [monthEnd, addDays(today, FLASH.maxDaysAhead + 1)].sort()[1]
    const [b, h] = await Promise.all([
      supabase.from('flash_bookings').select('id,booking_group,user_id,booked_by_name,slot_start,slot_end,purpose').is('cancelled_at', null).gte('slot_start', slotStart(from, 0).toISOString()).lt('slot_start', slotStart(to, 0).toISOString()).order('slot_start').limit(5000),
      supabase.from('flash_holidays').select('holiday_date,name,source').gte('holiday_date', addDays(today, -31)).order('holiday_date'),
    ])
    const failure = b.error ?? h.error
    if (failure) setError(explain(await getSupabaseErrorMessage(failure, 'Unable to load bookings.')))
    else { setError(''); setBookings((b.data ?? []) as Booking[]); setHolidays((h.data ?? []) as Holiday[]) }
    setLoading(false); setNow(new Date())
  }, [month, today])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    // Live view of other people's bookings; refetch on focus as a fallback.
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void load(), 300) }
    const channel = supabase.channel('flash-sync').on('postgres_changes', { event: '*', schema: 'public', table: 'flash_bookings' }, schedule).on('postgres_changes', { event: '*', schema: 'public', table: 'flash_holidays' }, schedule).subscribe()
    const onVisible = () => { if (document.visibilityState === 'visible') schedule() }
    document.addEventListener('visibilitychange', onVisible); const tick = setInterval(() => setNow(new Date()), 60000)
    return () => { clearTimeout(timer); clearInterval(tick); document.removeEventListener('visibilitychange', onVisible); void supabase.removeChannel(channel) }
  }, [load])

  const holidayOn = useMemo(() => new Map(holidays.map(h => [h.holiday_date, h])), [holidays])
  const bySlot = useMemo(() => new Map(bookings.map(b => [new Date(b.slot_start).getTime(), b])), [bookings])
  const groups = useMemo<Group[]>(() => { const map = new Map<string, Group>(); for (const b of bookings) { const g = map.get(b.booking_group); const s = new Date(b.slot_start), e = new Date(b.slot_end); if (!g) map.set(b.booking_group, { group: b.booking_group, user_id: b.user_id, who: b.booked_by_name, start: s, end: e, slots: 1, purpose: b.purpose }); else { g.slots++; if (s < g.start) g.start = s; if (e > g.end) g.end = e } } return [...map.values()].sort((a, b) => a.start.getTime() - b.start.getTime()) }, [bookings])
  const holiday = holidayOn.get(day)
  const slotState = (hour: number) => { const at = slotStart(day, hour); const b = bySlot.get(at.getTime()); return b ? { kind: 'booked' as const, booking: b } : at < now ? { kind: 'past' as const } : holiday ? { kind: 'holiday' as const } : { kind: 'free' as const } }
  const maxFrom = (hour: number) => { let n = 0; while (n < FLASH.maxSlots && hour + n < FLASH.close && slotState(hour + n).kind === 'free') n++; return n }
  const tooFar = day > addDays(today, FLASH.maxDaysAhead)
  useEffect(() => { setStart(null); setSlots(1) }, [day])
  useEffect(() => { if (start !== null && slots > maxFrom(start)) setSlots(Math.max(1, maxFrom(start))) }) // a slot was taken meanwhile

  const book = async (event: FormEvent) => {
    event.preventDefault()
    if (start === null || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    const { error: rpcError } = await supabase.rpc('book_flash_slots', { p_date: day, p_start_hour: start, p_slots: slots, p_purpose: purpose.trim() || null })
    inFlight.current = false; setBusy(false)
    if (rpcError) { setError(explain(await getSupabaseErrorMessage(rpcError, 'The booking failed.'))); await load(); return }
    setNotice(`Booked ${pad(start)}:00–${pad(start + slots)}:00 on ${dayLabel(day, { weekday: 'short', day: 'numeric', month: 'short' })}.`); setStart(null); setSlots(1); setPurpose(''); await load()
  }
  const cancel = async (group: Group) => {
    if (!window.confirm(`Cancel the booking ${labTime(group.start)}–${labTime(group.end)} on ${dayLabel(labDate(group.start), { day: 'numeric', month: 'short' })}?`)) return
    setError(''); setNotice('')
    const { error: rpcError } = await supabase.rpc('cancel_flash_booking', { p_booking_group: group.group })
    if (rpcError) setError(explain(await getSupabaseErrorMessage(rpcError, 'The booking could not be cancelled.'))); else setNotice('Booking cancelled.')
    await load()
  }

  const strip = Array.from({ length: 14 }, (_, i) => addDays(today, i))
  const upcoming = groups.filter(g => g.end > now)
  const histogram = useMemo(() => {
    const rows = new Map<string, { name: string; Completed: number; Upcoming: number; hours: number }>()
    for (const g of groups) { if (labDate(g.start).slice(0, 7) !== month) continue; const row = rows.get(g.user_id) ?? { name: g.user_id === profile?.id ? `${g.who} (you)` : g.who, Completed: 0, Upcoming: 0, hours: 0 }; if (g.end <= now) row.Completed++; else row.Upcoming++; row.hours += g.slots; rows.set(g.user_id, row) }
    return [...rows.values()].sort((a, b) => b.Completed + b.Upcoming - (a.Completed + a.Upcoming))
  }, [groups, month, now, profile?.id])

  return <div className="flash-page">
    <div className="title-row"><div><p className="eyebrow">INSTRUMENT BOOKING <span>•</span> LIVE</p><h1>Flash chromatography</h1><p className="subtitle">Book in 1-hour slots between {pad(FLASH.open)}:00 and {pad(FLASH.close)}:00 (IST), up to {FLASH.maxSlots} consecutive hours. Public holidays from Google Calendar cannot be booked.</p></div><button className="secondary" onClick={() => void load()}><RefreshCw size={15}/> Refresh</button></div>
    {error && <div className="user-error page-notice">{error}</div>}{notice && <div className="admin-success page-notice">{notice}</div>}
    <div className="flash-grid">
      <section className="panel flash-book">
        <div className="panel-heading"><div><h2>Book a slot</h2><p>Everyone can see who has booked each hour.</p></div><label className="flash-date"><CalendarDays size={14}/><input type="date" value={day} min={today} max={addDays(today, FLASH.maxDaysAhead)} onChange={event => event.target.value && setDay(event.target.value)}/></label></div>
        <div className="day-strip">{strip.map(date => { const h = holidayOn.get(date); const booked = HOURS.filter(hour => bySlot.has(slotStart(date, hour).getTime())).length; return <button key={date} className={`day-chip${date === day ? ' active' : ''}${h ? ' holiday' : ''}`} onClick={() => setDay(date)} title={h ? h.name : `${booked} of ${HOURS.length} hours booked`}><span>{dayLabel(date, { weekday: 'short' })}</span><b>{dayLabel(date, { day: 'numeric' })}</b><small>{h ? 'Holiday' : `${HOURS.length - booked} free`}</small></button> })}</div>
        <div className="flash-day-head"><button className="icon-button" aria-label="Previous day" disabled={day <= today} onClick={() => setDay(addDays(day, -1))}><ChevronLeft size={16}/></button><h3>{dayLabel(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3><button className="icon-button" aria-label="Next day" disabled={day >= addDays(today, FLASH.maxDaysAhead)} onClick={() => setDay(addDays(day, 1))}><ChevronRight size={16}/></button></div>
        {holiday && <div className="flash-holiday"><CalendarOff size={16}/> {holiday.name} — {holiday.source === 'google' ? 'public holiday (Google Calendar)' : 'lab closed'}. The instrument cannot be booked.</div>}
        {tooFar && <div className="user-error">Bookings open {FLASH.maxDaysAhead} days in advance.</div>}
        <div className="slot-list">{loading ? <div className="loading-row">Loading bookings...</div> : HOURS.map(hour => { const state = slotState(hour); const selected = start !== null && hour >= start && hour < start + slots; return <div key={hour} className={`slot slot-${state.kind}${selected ? ' selected' : ''}`}><span className="slot-time"><Clock size={12}/> {pad(hour)}:00 – {pad(hour + 1)}:00</span>{state.kind === 'booked' ? <span className="slot-who"><b>{state.booking.user_id === profile?.id ? 'You' : state.booking.booked_by_name}</b>{state.booking.purpose && <small>{state.booking.purpose}</small>}</span> : state.kind === 'free' && !tooFar ? <button type="button" className={selected ? 'primary slot-pick' : 'secondary slot-pick'} onClick={() => { setStart(hour); setSlots(s => Math.min(Math.max(1, s), maxFrom(hour))) }}>{selected ? 'Selected' : 'Available'}</button> : <span className="muted">{state.kind === 'past' ? 'Past' : state.kind === 'holiday' ? 'Holiday' : '—'}</span>}</div> })}</div>
        {start !== null && <form className="flash-form" onSubmit={book}>
          <label>Duration<select value={slots} onChange={event => setSlots(Number(event.target.value))}>{Array.from({ length: FLASH.maxSlots }, (_, i) => i + 1).map(n => <option key={n} value={n} disabled={n > maxFrom(start)}>{n} hour{n > 1 ? 's' : ''} ({pad(start)}:00–{pad(start + n)}:00){n > maxFrom(start) ? ' — not available' : ''}</option>)}</select></label>
          <label>Purpose <small>Optional</small><input value={purpose} maxLength={200} onChange={event => setPurpose(event.target.value)} placeholder="e.g. Purification of compound 4b"/></label>
          <button className="primary" disabled={busy}>{busy ? 'Booking...' : `Book ${pad(start)}:00–${pad(start + slots)}:00`}</button>
        </form>}
      </section>
      <section className="panel flash-upcoming"><div className="panel-heading"><div><h2>Upcoming bookings</h2><p>All researchers{isAdmin ? ' · you can cancel any booking' : ' · you can cancel your own'}</p></div></div>
        <div className="upcoming-list">{upcoming.map(g => <div key={g.group} className={`upcoming${g.user_id === profile?.id ? ' mine' : ''}`}><div><b>{dayLabel(labDate(g.start), { weekday: 'short', day: 'numeric', month: 'short' })} · {labTime(g.start)}–{labTime(g.end)}</b><span>{g.user_id === profile?.id ? 'You' : g.who}{g.purpose ? ` · ${g.purpose}` : ''}</span></div>{(g.user_id === profile?.id && g.start > now) || isAdmin ? <button className="table-action danger" onClick={() => void cancel(g)} aria-label="Cancel booking"><Trash2 size={12}/> Cancel</button> : null}</div>)}{!loading && upcoming.length === 0 && <div className="empty-users">No upcoming bookings.</div>}</div>
      </section>
    </div>
    <section className="panel chart-panel flash-histogram"><div className="panel-heading"><div><h2>Flash usage per researcher</h2><p>Bookings per person in {new Date(`${month}-15T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}; a 2–3 hour booking counts once</p></div><input className="analytics-select" type="month" value={month} onChange={event => event.target.value && setMonth(event.target.value)} aria-label="Month"/></div>
      <div className="chart">{histogram.length === 0 ? <div className="empty-users">No Flash bookings in this month.</div> : <ResponsiveContainer width="100%" height="100%"><BarChart data={histogram} margin={{ left: 0, right: 16, top: 8 }}><CartesianGrid vertical={false} stroke="#e4ebe7"/><XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fill: '#64736e', fontSize: 11 }}/><YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#83918c', fontSize: 11 }}/><Tooltip formatter={(value, key) => [`${value} booking${Number(value) === 1 ? '' : 's'}`, key]} labelFormatter={(label, items) => `${label} · ${items?.[0]?.payload?.hours ?? 0} h booked`}/><Legend/><Bar dataKey="Completed" stackId="u" fill="#287c70" radius={[0, 0, 0, 0]}/><Bar dataKey="Upcoming" stackId="u" fill="#85b9ae" radius={[4, 4, 0, 0]}/></BarChart></ResponsiveContainer>}</div>
    </section>
    {isAdmin && <HolidayAdmin holidays={holidays} today={today} onChanged={load} setError={setError} setNotice={setNotice}/>}
  </div>
}

function HolidayAdmin({ holidays, today, onChanged, setError, setNotice }: { holidays: Holiday[]; today: string; onChanged: () => Promise<void>; setError: (m: string) => void; setNotice: (m: string) => void }) {
  const [date, setDate] = useState(''); const [name, setName] = useState(''); const [syncing, setSyncing] = useState(false)
  const upcoming = holidays.filter(h => h.holiday_date >= today).slice(0, 40)
  const sync = async () => {
    setSyncing(true); setError(''); setNotice('')
    const { data, error } = await supabase.functions.invoke('sync-flash-holidays', { body: {} })
    setSyncing(false)
    if (error) { setError(await getSupabaseErrorMessage(error, 'Holiday sync failed. Is the sync-flash-holidays function deployed?')); return }
    setNotice(`Synced ${(data as { synced: number }).synced} public holidays from Google Calendar.`); await onChanged()
  }
  const add = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice('')
    const { error } = await supabase.rpc('set_flash_holiday', { p_date: date, p_name: name.trim() })
    if (error) { setError(await getSupabaseErrorMessage(error, 'Could not add the closure.')); return }
    setNotice(`${date} is now closed for Flash bookings.`); setDate(''); setName(''); await onChanged()
  }
  const remove = async (h: Holiday) => {
    if (!window.confirm(`Allow bookings on ${h.holiday_date} (${h.name})?${h.source === 'google' ? ' The next Google Calendar sync will add it back.' : ''}`)) return
    const { error } = await supabase.rpc('remove_flash_holiday', { p_date: h.holiday_date })
    if (error) setError(await getSupabaseErrorMessage(error, 'Could not remove the holiday.')); else { setNotice(`${h.holiday_date} reopened.`); await onChanged() }
  }
  return <section className="panel admin-section flash-holidays"><div className="panel-heading"><div><h2>Holidays and closures</h2><p>Public holidays from Google Calendar (India) plus lab closures you add. No one can book on these dates.</p></div><button className="secondary" disabled={syncing} onClick={() => void sync()}><RefreshCw size={14}/> {syncing ? 'Syncing...' : 'Sync from Google Calendar'}</button></div>
    <form className="import-actions" onSubmit={add}><input type="date" required min={today} value={date} onChange={event => setDate(event.target.value)} aria-label="Closure date"/><input required maxLength={100} placeholder="Reason, e.g. Instrument maintenance" value={name} onChange={event => setName(event.target.value)}/><button className="primary">Close this date</button></form>
    <div className="table-wrap"><table className="compact-table"><thead><tr><th>DATE</th><th>NAME</th><th>SOURCE</th><th></th></tr></thead><tbody>{upcoming.map(h => <tr key={h.holiday_date}><td>{dayLabel(h.holiday_date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</td><td>{h.name}</td><td>{h.source === 'google' ? 'Google Calendar' : 'Lab closure'}</td><td><button className="table-action" onClick={() => void remove(h)}>Allow bookings</button></td></tr>)}{upcoming.length === 0 && <tr><td colSpan={4}><div className="empty-users">No holidays loaded yet. Use “Sync from Google Calendar”.</div></td></tr>}</tbody></table></div>
  </section>
}
