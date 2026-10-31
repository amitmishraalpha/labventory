import * as XLSX from 'xlsx'

// Reads the lab's solvent sheet: a "Commercial Solvents" block (Solvent name, Pack size, No. of Cans,
// Make, Location) and a "D Solvents" (NMR) block (Solvent, Pack size, bottles, Bottle ID, Location,
// Available Qty, Last used by) side by side on one worksheet. Each physical can/bottle becomes one row.
// Source values are kept as written in `raw`; nothing is guessed silently: every assumption is a flag.

export type SolventCategory = 'COMMERCIAL_SOLVENT' | 'NMR_SOLVENT'
export type SolventRow = {
  row: number; part: string | null; category: SolventCategory; name: string; bottle_id: string; generated_id: boolean
  pack_size: string; pack_unit: string; quantity: string; quantity_unit: string; make: string; place: string; legacy_last_used_by: string
  flag: string; raw: Record<string, string>
}
export type SolventSheet = { rows: SolventRow[]; sections: Array<{ category: SolventCategory; title: string; sourceRows: number }>; problems: string[] }

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** "25 lit" -> 25 / "lit"; "100ml" -> 100 / "ml". Unit text is passed through; the server normalises or rejects it. */
export function splitAmount(text: string): { amount: string; unit: string } {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Zµμ]+)?\.?$/)
  return match ? { amount: match[1], unit: match[2] ?? '' } : { amount: '', unit: '' }
}
const slug = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 16) || 'SOLVENT'
/** Next ID after the last one listed: CD01 -> CD02; otherwise ID-2, ID-3. */
function nextId(base: string, index: number) {
  const match = base.match(/^(.*?)(\d+)$/)
  return match ? `${match[1]}${String(Number(match[2]) + index).padStart(match[2].length, '0')}` : `${base}-${index + 1}`
}

export function gridFromWorkbook(buffer: ArrayBuffer): string[][] {
  const book = XLSX.read(buffer, { type: 'array' })
  const sheet = book.Sheets[book.SheetNames[0]]
  if (!sheet?.['!ref']) throw new Error('The first worksheet is empty.')
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const grid: string[][] = []
  for (let r = 0; r <= range.e.r; r++) { const row: string[] = []; for (let c = 0; c <= range.e.c; c++) { const cell = sheet[XLSX.utils.encode_cell({ r, c })]; row.push(cell?.v == null ? '' : String(cell.w ?? cell.v).trim()) } grid.push(row) }
  return grid
}

export function parseSolventGrid(grid: string[][]): SolventSheet {
  const problems: string[] = []
  // Section titles and the column where each starts.
  const titles: Array<{ category: SolventCategory; title: string; row: number; col: number }> = []
  grid.forEach((cells, r) => cells.forEach((cell, c) => {
    const n = norm(cell)
    if (n === 'commercial solvents' || n === 'commercial solvent') titles.push({ category: 'COMMERCIAL_SOLVENT', title: cell, row: r, col: c })
    else if (n === 'd solvents' || n === 'nmr solvents' || n === 'deuterated solvents') titles.push({ category: 'NMR_SOLVENT', title: cell, row: r, col: c })
  }))
  if (!titles.length) throw new Error('No “Commercial Solvents” or “D Solvents” section title was found in the first worksheet.')
  titles.sort((a, b) => a.col - b.col)
  const rows: SolventRow[] = []; const sections: SolventSheet['sections'] = []
  titles.forEach((section, index) => {
    const lastCol = index + 1 < titles.length ? titles[index + 1].col - 1 : Math.max(...grid.map(row => row.length)) - 1
    const span = (cells: string[]) => cells.slice(section.col, lastCol + 1)
    const headerRow = grid.findIndex((cells, r) => r >= section.row && span(cells).some(cell => norm(cell) === 'pack size'))
    if (headerRow < 0) { problems.push(`${section.title}: no header row with “Pack size” was found.`); return }
    const headers = span(grid[headerRow]).map(norm)
    const col = (...names: string[]) => { const i = headers.findIndex(h => names.includes(h)); return i < 0 ? -1 : i }
    const nameCol = col('solvent', 'solvent name', 'name') >= 0 ? col('solvent', 'solvent name', 'name') : 0 // Commercial block: names sit under the title, no header
    const packCol = col('pack size'), countCol = col('no of cans', 'cans', 'no of bottles', 'bottles', 'number of bottles', 'number of cans')
    const makeCol = col('make', 'manufacturer'), placeCol = col('location', 'place'), idCol = col('bottle id', 'bottle ids'), qtyCol = col('available qty', 'available quantity'), lastCol2 = col('last used by')
    const originals = span(grid[headerRow])
    let sourceRows = 0
    for (let r = headerRow + 1; r < grid.length; r++) {
      const cells = span(grid[r]); const name = cells[nameCol] ?? ''
      if (!name) { if (cells.every(cell => !cell)) continue; problems.push(`Row ${r + 1}: ${section.title} row has values but no solvent name; skipped.`); continue }
      sourceRows++
      const raw: Record<string, string> = { section: section.title }
      originals.forEach((header, i) => { if (cells[i]) raw[header || (i === nameCol ? 'Solvent Name' : `Column ${i + 1}`)] = cells[i] })
      const pack = splitAmount(cells[packCol] ?? '')
      const countText = countCol >= 0 ? cells[countCol] ?? '' : ''
      const count = /^\d+$/.test(countText) && Number(countText) > 0 ? Number(countText) : 1
      const ids = idCol >= 0 ? (cells[idCol] ?? '').split(/[,;/\s]+/).map(id => id.trim()).filter(Boolean) : []
      const available = qtyCol >= 0 ? splitAmount(cells[qtyCol] ?? '') : { amount: '', unit: '' }
      const base = { row: r + 1, category: section.category, name, pack_size: pack.amount, pack_unit: pack.unit, make: makeCol >= 0 ? cells[makeCol] ?? '' : '', place: placeCol >= 0 ? cells[placeCol] ?? '' : '', legacy_last_used_by: lastCol2 >= 0 ? cells[lastCol2] ?? '' : '', raw: { ...raw, pack_size: cells[packCol] ?? '' } }
      const nameFlag = /^can-?d3$/i.test(name) ? `Label kept exactly as written (“${name}”); please verify the solvent's identity (e.g. acetonitrile-d3, CD3CN).` : ''
      if (countText && !/^\d+$/.test(countText)) problems.push(`Row ${r + 1}: number of ${section.category === 'COMMERCIAL_SOLVENT' ? 'cans' : 'bottles'} “${countText}” is not a whole number; 1 assumed.`)
      for (let i = 0; i < count; i++) {
        const listed = ids[i]; const part = count > 1 ? `${i + 1} of ${count}` : null
        let bottleId = listed ?? ''; let generated = false; const flags = [nameFlag]
        if (!bottleId) { generated = true; bottleId = section.category === 'COMMERCIAL_SOLVENT' ? `CS-${slug(name)}-${String(i + 1).padStart(2, '0')}` : ids.length ? nextId(ids[ids.length - 1], i - ids.length + 1) : `NMR-${slug(name)}-${String(i + 1).padStart(2, '0')}` }
        // The sheet's single "Available Qty" belongs to the listed bottle; extra bottles have no recorded amount.
        const known = i === 0 && available.amount ? available : { amount: '', unit: '' }
        if (count > 1 && i > 0 && available.amount) flags.push(`The sheet lists ${count} bottles but one available quantity (${cells[qtyCol]}); it is assigned to ${ids[0] ?? 'the first bottle'} and this bottle's amount must be checked.`)
        rows.push({ ...base, part, bottle_id: bottleId, generated_id: generated, quantity: known.amount, quantity_unit: known.unit, flag: flags.filter(Boolean).join(' ') })
      }
    }
    sections.push({ category: section.category, title: section.title, sourceRows })
  })
  return { rows, sections, problems }
}
