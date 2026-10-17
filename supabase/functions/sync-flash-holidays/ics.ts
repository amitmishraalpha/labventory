// Minimal iCalendar (RFC 5545) reader for Google Calendar's public holiday feeds.
// Only all-day events whose description starts with "Public holiday" are kept, so
// observances (e.g. Vasant Panchami) do not block the instrument.
export type Holiday = { date: string; name: string }

const unescape = (value: string) => value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`

export function parsePublicHolidays(ics: string): Holiday[] {
  // Unfold continuation lines (a line starting with a space/tab continues the previous one).
  const lines = ics.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const out: Holiday[] = []
  let event: Record<string, string> | null = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { event = {}; continue }
    if (line === 'END:VEVENT') {
      if (event) {
        const start = event.DTSTART?.match(/^(\d{8})$/)?.[1]
        const end = event.DTEND?.match(/^(\d{8})$/)?.[1]
        const description = unescape(event.DESCRIPTION ?? '')
        if (start && /^public holiday/i.test(description.trim()) && event.SUMMARY) {
          // All-day DTEND is exclusive; expand multi-day holidays.
          const day = new Date(`${iso(start)}T00:00:00Z`); const stop = end ? new Date(`${iso(end)}T00:00:00Z`) : new Date(day.getTime() + 86400000)
          for (; day < stop; day.setUTCDate(day.getUTCDate() + 1)) out.push({ date: day.toISOString().slice(0, 10), name: unescape(event.SUMMARY).trim() })
        }
      }
      event = null; continue
    }
    if (!event) continue
    const colon = line.indexOf(':'); if (colon < 0) continue
    const key = line.slice(0, colon).split(';')[0].toUpperCase()
    if (['DTSTART', 'DTEND', 'SUMMARY', 'DESCRIPTION'].includes(key)) event[key] = line.slice(colon + 1)
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}
