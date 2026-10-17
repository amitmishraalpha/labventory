import { useState, type MouseEvent } from 'react'
import { ExternalLink } from 'lucide-react'

// Resolves a chemical to its PubChem compound page with the PUG REST API (CAS No first,
// then name). Lookups happen on hover/focus/click only, are cached, and are spaced out to
// stay well under PubChem's 5 requests/second limit.
type Hit = { cid: number; title: string } | null
const API = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name'
const cache = new Map<string, Promise<Hit>>()
let last = 0
const searchUrl = (term: string) => `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(term)}`
const compoundUrl = (cid: number) => `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`

async function lookup(term: string): Promise<Hit> {
  const wait = Math.max(0, last + 250 - Date.now()); last = Date.now() + wait
  if (wait) await new Promise(resolve => setTimeout(resolve, wait))
  const response = await fetch(`${API}/${encodeURIComponent(term)}/property/Title/JSON`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`PubChem ${response.status}`)
  const row = (await response.json())?.PropertyTable?.Properties?.[0]
  return row?.CID ? { cid: row.CID, title: row.Title ?? term } : null
}
function resolve(name: string, cas: string | null | undefined): Promise<Hit> {
  const key = `${cas ?? ''}|${name}`.toLowerCase()
  try { const stored = sessionStorage.getItem(`pubchem:${key}`); if (stored) return Promise.resolve(JSON.parse(stored) as Hit) } catch { /* storage unavailable */ }
  if (!cache.has(key)) {
    const job = (async () => { const byCas = cas ? await lookup(cas) : null; return byCas ?? await lookup(name) })()
    job.then(hit => { try { sessionStorage.setItem(`pubchem:${key}`, JSON.stringify(hit)) } catch { /* ignore */ } }, () => cache.delete(key))
    cache.set(key, job)
  }
  return cache.get(key)!
}

export default function PubChemLink({ name, cas }: { name: string; cas?: string | null }) {
  const [hit, setHit] = useState<Hit | undefined>(undefined)
  const prefetch = () => { if (hit === undefined) resolve(name, cas).then(setHit, () => setHit(undefined)) }
  const href = hit ? compoundUrl(hit.cid) : searchUrl(cas || name)
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.stopPropagation()
    if (hit !== undefined) return // resolved: follow the link normally
    // Open the tab inside the click (popup blockers), then point it at the compound once resolved.
    event.preventDefault()
    const tab = window.open('about:blank', '_blank'); if (tab) tab.opener = null
    resolve(name, cas).then(found => { setHit(found); if (tab) tab.location.href = found ? compoundUrl(found.cid) : searchUrl(cas || name) }, () => { if (tab) tab.location.href = searchUrl(cas || name) })
  }
  return <a className="pubchem-link" href={href} target="_blank" rel="noopener noreferrer" onMouseEnter={prefetch} onFocus={prefetch} onClick={open}
    title={hit ? `PubChem CID ${hit.cid}: ${hit.title}` : hit === null ? `Not found in PubChem; opens a PubChem search for ${cas || name}` : `View ${name} on PubChem`}
    aria-label={`View ${name} on PubChem`}><ExternalLink size={11}/> PubChem</a>
}
