import Papa from 'papaparse'
import * as XLSX from 'xlsx'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_ROWS = 5000

// The columns of the laboratory chemicals list. Nothing else is imported.
export type FieldKey = 'serial' | 'chemical_name' | 'cas_name' | 'cas_number' | 'make' | 'bottle_size' | 'quantity' | 'place' | 'tray'
export type Field = { key: FieldKey; label: string; required?: boolean; aliases: string[] }
export const FIELDS: Field[] = [
  { key: 'serial', label: 'S.No', aliases: ['s no', 'sno', 'sl no', 'sr no', 'serial no', 'serial number'] },
  { key: 'chemical_name', label: 'Chemical Name', required: true, aliases: ['chemical name', 'chemical', 'name'] },
  { key: 'cas_name', label: 'Name imported from CAS No', aliases: ['name imported from cas no', 'name from cas no', 'name from cas', 'cas name'] },
  { key: 'cas_number', label: 'Cas No', aliases: ['cas no', 'cas', 'cas number', 'cas rn'] },
  { key: 'make', label: 'Make', aliases: ['make', 'manufacturer', 'brand', 'company'] },
  { key: 'bottle_size', label: 'Bottle size', aliases: ['bottle size', 'size', 'pack size'] },
  { key: 'quantity', label: 'Available quantity', required: true, aliases: ['approx avilable quantity g ml', 'approx available quantity g ml', 'approx available quantity', 'available quantity', 'quantity', 'qty'] },
  { key: 'place', label: 'Place', aliases: ['place', 'location', 'room', 'rack'] },
  { key: 'tray', label: 'Tray No.', aliases: ['tray no', 'tray', 'tray number'] },
]

export type Sheet = { fileName: string; sha256: string; headers: string[]; rows: Array<{ rowNumber: number; cells: string[] }> }
export type Mapping = Partial<Record<FieldKey, number>>
// One payload row per physical bottle. A spreadsheet row listing several bottles yields several.
export type ImportRow = {
  row_number: number; bottle_part: string; raw: Record<string, string>
  chemical_name: string; cas_number: string; manufacturer: string; bottle_size: string; bottle_size_unit: string
  current_quantity: string; quantity_unit: string; room: string; tray: string
  client_errors: string[]; client_warnings: string[]
}

const normHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

async function sha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function readSpreadsheet(file: File): Promise<Sheet> {
  const extension = file.name.toLowerCase().split('.').pop()
  if (extension !== 'csv' && extension !== 'xlsx') throw new Error('Only .xlsx and .csv files are supported.')
  if (file.size > MAX_FILE_BYTES) throw new Error('The file is larger than 10 MB.')
  if (file.size === 0) throw new Error('The file is empty.')
  const buffer = await file.arrayBuffer()
  let grid: string[][]
  if (extension === 'csv') {
    const text = new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, '')
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false })
    if (parsed.errors.length) { const first = parsed.errors[0]; throw new Error(`CSV could not be parsed${first.row != null ? ` near row ${first.row + 1}` : ''}: ${first.message}`) }
    grid = parsed.data.map(row => row.map(cell => String(cell ?? '').trim()))
  } else {
    const book = XLSX.read(buffer, { type: 'array' })
    const sheet = book.Sheets[book.SheetNames[0]]
    if (!sheet || !sheet['!ref']) throw new Error('The first worksheet is empty.')
    const range = XLSX.utils.decode_range(sheet['!ref'])
    grid = []
    for (let r = 0; r <= range.e.r; r++) {
      const row: string[] = []
      for (let c = range.s.c; c <= range.e.c; c++) { const cell = sheet[XLSX.utils.encode_cell({ r, c })]; row.push(r < range.s.r || cell?.v == null ? '' : String(cell.w ?? cell.v).trim()) }
      grid.push(row)
    }
  }
  const headerIndex = grid.findIndex(row => row.some(cell => cell !== ''))
  if (headerIndex < 0) throw new Error('The file has no header row.')
  const headers = grid[headerIndex].map((header, index) => header || `Column ${index + 1}`)
  const rows = grid.slice(headerIndex + 1).map((cells, offset) => ({ rowNumber: headerIndex + offset + 2, cells })).filter(row => row.cells.some(cell => cell !== ''))
  if (!rows.length) throw new Error('The file has a header row but no data rows.')
  if (rows.length > MAX_ROWS) throw new Error(`The file has ${rows.length} data rows; the maximum per import is ${MAX_ROWS}.`)
  return { fileName: file.name, sha256: await sha256(buffer), headers, rows }
}

export function autoMap(headers: string[]): Mapping {
  const mapping: Mapping = {}; const used = new Set<number>(); const normalized = headers.map(normHeader)
  for (const field of FIELDS) {
    const index = normalized.findIndex((header, i) => !used.has(i) && field.aliases.includes(header))
    if (index >= 0) { mapping[field.key] = index; used.add(index) }
  }
  return mapping
}

const units: Record<string, string> = { g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', mg: 'mg', kg: 'kg', ug: 'µg', 'µg': 'µg', 'μg': 'µg', mcg: 'µg', ml: 'mL', l: 'L', lit: 'L', ltr: 'L', litre: 'L', liter: 'L', litres: 'L', liters: 'L', ul: 'µL', 'µl': 'µL', 'μl': 'µL' }
type Amount = { value: string; unit: string }

/** Reads "25 g", "25 g X2", "5 g + 15 g", "100g/25g x2", "80g x 20g" into one amount per bottle. */
export function parseAmounts(text: string): { amounts: Amount[]; error?: string } {
  const source = text.replace(/[`´]/g, '').trim()
  if (!source) return { amounts: [] }
  const amounts: Amount[] = []
  for (const part of source.split(/\s*[/+]\s*/).filter(Boolean)) {
    // "x" followed by an amount with a unit separates bottles ("80g x 20g"); "x 2" multiplies.
    for (const piece of part.split(/\s*[x×]\s*(?=\d+(?:\.\d+)?\s*[a-zµμ])/i)) {
      const match = piece.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zµμ]+)?\s*(?:[x×]\s*(\d+))?$/i)
      if (!match) return { amounts: [], error: `"${text.trim()}" could not be read as a quantity.` }
      const count = match[3] ? Number(match[3]) : 1
      if (count < 1 || count > 50) return { amounts: [], error: `"${text.trim()}" has an unrealistic bottle count.` }
      const unit = match[2] ? units[match[2].toLowerCase()] ?? match[2] : ''
      for (let i = 0; i < count; i++) amounts.push({ value: match[1], unit })
    }
  }
  // "25/100 g": a missing unit is taken from a later amount in the same cell. Never from an
  // earlier one ("2 Lit + 1 Lit / 450" means 450 of that bottle's own unit, not 450 L).
  amounts.forEach((amount, i) => { if (!amount.unit) amount.unit = amounts.slice(i + 1).find(a => a.unit)?.unit ?? '' })
  return { amounts }
}

/** "SRL/Avra", "Avra x 2/Spectrochem", "Spectrochemx 2" -> one make per bottle when the count lines up. */
function parseMakes(text: string, bottles: number): { makes: string[]; warning?: string } {
  const source = text.trim()
  if (!source) return { makes: Array(bottles).fill('') }
  const expanded = source.split('/').map(part => part.trim()).filter(Boolean).flatMap(part => { const m = part.match(/^(.*?)\s*x\s*(\d+)$/i); return m && m[1] ? Array(Number(m[2])).fill(m[1].trim()) : [part] })
  if (new Set(expanded.map(make => make.toLowerCase())).size === 1) return { makes: Array(bottles).fill(expanded[0]) }
  if (expanded.length === bottles) return { makes: expanded }
  return { makes: Array(bottles).fill(source), warning: `Make "${source}" lists ${expanded.length} names for ${bottles} bottle(s); stored as written.` }
}

function casValid(cas: string) {
  if (!/^\d{2,7}-\d{2}-\d$/.test(cas)) return false
  const digits = cas.replace(/-/g, '').split('').map(Number); const check = digits.pop()!
  return digits.reverse().reduce((sum, digit, i) => sum + digit * (i + 1), 0) % 10 === check
}

export function buildRows(sheet: Sheet, mapping: Mapping): ImportRow[] {
  const get = (cells: string[], key: FieldKey) => { const index = mapping[key]; return index == null ? '' : (cells[index] ?? '').trim() }
  const out: ImportRow[] = []
  for (const { rowNumber, cells } of sheet.rows) {
    // Rows holding only a serial number are blank lines in the register, not bottles.
    if ((Object.keys(mapping) as FieldKey[]).filter(key => key !== 'serial').every(key => !get(cells, key))) continue
    const raw: Record<string, string> = {}; sheet.headers.forEach((header, index) => { if (cells[index]) raw[header] = cells[index] })
    // CAS No is optional: a typo, EC number or name in that column is dropped with a warning
    // (the original text stays in raw_source) rather than rejecting the bottle.
    let cas = get(cells, 'cas_number').replace(/[.\s]+$/, '')
    const rowWarnings: string[] = []
    if (cas && !casValid(cas)) { rowWarnings.push(`Cas No "${cas}" is not a valid CAS number; imported without a CAS No.`); cas = '' }
    const base = {
      row_number: rowNumber, raw,
      chemical_name: get(cells, 'chemical_name') || get(cells, 'cas_name'),
      cas_number: cas,
      room: get(cells, 'place'), tray: get(cells, 'tray'),
    }
    const sizes = parseAmounts(get(cells, 'bottle_size')), quantities = parseAmounts(get(cells, 'quantity'))
    const errors = [sizes.error, quantities.error].filter((e): e is string => Boolean(e))
    let pairs: Array<{ size?: Amount; quantity?: Amount }> = []
    if (!errors.length) {
      const q = quantities.amounts, s = sizes.amounts
      if (q.length === 0) pairs = [{ size: s.length === 1 ? s[0] : undefined }]
      else if (s.length === q.length) pairs = q.map((quantity, i) => ({ quantity, size: s[i] }))
      else if (s.length <= 1) pairs = q.map(quantity => ({ quantity, size: s[0] }))
      else errors.push(`Bottle size lists ${s.length} bottles but available quantity lists ${q.length}; write one quantity per bottle (e.g. "5 g + 15 g").`)
    }
    if (errors.length) {
      out.push({ ...base, bottle_part: '', manufacturer: get(cells, 'make'), bottle_size: '', bottle_size_unit: '', current_quantity: get(cells, 'quantity'), quantity_unit: '', client_errors: errors, client_warnings: rowWarnings })
      continue
    }
    const { makes, warning } = parseMakes(get(cells, 'make'), pairs.length)
    pairs.forEach(({ size, quantity }, i) => {
      const warnings = [...rowWarnings, ...(warning ? [warning] : [])]
      let quantityUnit = quantity?.unit ?? ''
      // Header says "(g/mL)": a bare number takes its bottle's unit.
      if (quantity && !quantityUnit && size?.unit) { quantityUnit = size.unit; warnings.push(`Quantity "${quantity.value}" had no unit; ${size.unit} taken from the bottle size.`) }
      out.push({
        ...base, bottle_part: pairs.length > 1 ? `${i + 1} of ${pairs.length}` : '', raw: pairs.length > 1 ? { ...raw, _bottle: `${i + 1} of ${pairs.length}` } : raw,
        manufacturer: makes[i], bottle_size: size?.value ?? '', bottle_size_unit: size?.unit ?? '',
        current_quantity: quantity?.value ?? '', quantity_unit: quantityUnit, client_errors: [], client_warnings: warnings,
      })
    })
  }
  return out
}

export function downloadTemplate() {
  // Same headers as the laboratory register; no sample records.
  const sheet = XLSX.utils.aoa_to_sheet([['S.No', 'Chemical Name', 'Name_imported_from_Cas No', 'Cas No', 'Make', 'Bottle size', 'Approx available quantity (g/mL)', 'Place', 'Tray No.']])
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Sheet1'); XLSX.writeFile(book, 'labventory-import-template.xlsx')
}
