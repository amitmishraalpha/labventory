// Chemical search by name or CAS No. "532-27-4", "532 27 4" and "532274" all find the same CAS.
export function matchesChemical(query: string, name: string, cas: string | null | undefined, ...extra: Array<string | null | undefined>) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (`${name} ${cas ?? ''} ${extra.filter(Boolean).join(' ')}`.toLowerCase().includes(q)) return true
  const digits = q.replace(/[\s-]/g, '')
  return /^\d{2,}$/.test(digits) && Boolean(cas) && cas!.replace(/\D/g, '').includes(digits)
}
