import Papa from 'papaparse'
import * as XLSX from 'xlsx'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_ROWS = 5000

export type FieldKey = 'chemical_name' | 'cas_number' | 'manufacturer' | 'supplier' | 'bottle_id' | 'bottle_size' | 'bottle_size_unit' | 'current_quantity' | 'quantity_unit' | 'initial_quantity' | 'location' | 'cabinet' | 'shelf' | 'tray' | 'expiry_date' | 'purchase_date' | 'batch_lot_number' | 'catalog_number' | 'purity' | 'grade' | 'notes'
export type Field = { key: FieldKey; label: string; required?: boolean; aliases: string[] }

// Order matters: earlier fields claim a header first.
export const FIELDS: Field[] = [
  { key: 'chemical_name', label: 'Chemical name', required: true, aliases: ['chemical name', 'chemical', 'name', 'compound', 'compound name', 'product name', 'substance', 'chemical_name'] },
  { key: 'cas_number', label: 'CAS number', aliases: ['cas', 'cas number', 'cas no', 'cas rn', 'cas registry number', 'cas_number'] },
  { key: 'bottle_id', label: 'Bottle ID', aliases: ['bottle id', 'bottle no', 'bottle number', 'bottle code', 'bottle', 'barcode', 'qr code', 'container id'] },
  { key: 'current_quantity', label: 'Available quantity', required: true, aliases: ['available quantity', 'quantity available', 'current quantity', 'remaining quantity', 'quantity', 'qty', 'available', 'remaining', 'amount'] },
  { key: 'quantity_unit', label: 'Quantity unit', required: true, aliases: ['quantity unit', 'unit', 'units', 'uom', 'unit of measure'] },
  { key: 'bottle_size', label: 'Bottle size', aliases: ['bottle size', 'size', 'pack size', 'container size', 'capacity'] },
  { key: 'bottle_size_unit', label: 'Bottle size unit', aliases: ['bottle size unit', 'size unit', 'capacity unit', 'pack size unit'] },
  { key: 'initial_quantity', label: 'Initial quantity', aliases: ['initial quantity', 'original quantity', 'received quantity'] },
  { key: 'manufacturer', label: 'Manufacturer', aliases: ['manufacturer', 'make', 'brand', 'mfr', 'mfg'] },
  { key: 'supplier', label: 'Supplier', aliases: ['supplier', 'vendor', 'supplier name', 'vendor name', 'distributor'] },
  { key: 'location', label: 'Location / room', aliases: ['location', 'room', 'storage location', 'storage', 'lab'] },
  { key: 'cabinet', label: 'Cabinet', aliases: ['cabinet', 'cupboard', 'rack'] },
  { key: 'shelf', label: 'Shelf', aliases: ['shelf', 'shelf number'] },
  { key: 'tray', label: 'Tray number', aliases: ['tray', 'tray number', 'tray no', 'tray id'] },
  { key: 'expiry_date', label: 'Expiry date', aliases: ['expiry date', 'expiry', 'expiration date', 'expiration', 'exp date', 'expires', 'use by'] },
  { key: 'purchase_date', label: 'Purchase date', aliases: ['purchase date', 'date received', 'received date', 'received', 'purchased'] },
  { key: 'batch_lot_number', label: 'Batch / lot number', aliases: ['lot number', 'batch number', 'lot', 'batch', 'lot no', 'batch no', 'batch lot', 'batch lot number'] },
  { key: 'catalog_number', label: 'Catalog number', aliases: ['catalog number', 'catalogue number', 'catalog no', 'cat no', 'catalog', 'product code', 'product number'] },
  { key: 'purity', label: 'Purity', aliases: ['purity', 'assay'] },
  { key: 'grade', label: 'Grade', aliases: ['grade'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'remarks', 'comments', 'comment'] },
]

export type Sheet = { fileName: string; sha256: string; headers: string[]; rows: Array<{ rowNumber: number; cells: string[] }> }
export type Mapping = Partial<Record<FieldKey, number>>
export type ImportRow = Record<string, unknown> & { row_number: number; raw: Record<string, string> }

const normHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

async function sha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
const pad = (n: number) => String(n).padStart(2, '0')
// Bundlers load xlsx.mjs (named SSF export); Node's CJS interop only exposes it on default.
const SSF: typeof XLSX.SSF = XLSX.SSF ?? (XLSX as unknown as { default: typeof XLSX }).default.SSF

function xlsxCellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v == null) return ''
  // Convert date serials from their date code directly so the browser time zone cannot shift the day.
  if (cell.t === 'n' && typeof cell.v === 'number' && cell.z && SSF.is_date(String(cell.z))) {
    const date = SSF.parse_date_code(cell.v)
    if (date) return `${date.y}-${pad(date.m)}-${pad(date.d)}`
  }
  if (cell.t === 'd' && cell.v instanceof Date) return `${cell.v.getFullYear()}-${pad(cell.v.getMonth() + 1)}-${pad(cell.v.getDate())}`
  return String(cell.v).trim()
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
    const book = XLSX.read(buffer, { type: 'array', cellDates: false, cellNF: true })
    const sheet = book.Sheets[book.SheetNames[0]]
    if (!sheet || !sheet['!ref']) throw new Error('The first worksheet is empty.')
    const range = XLSX.utils.decode_range(sheet['!ref'])
    grid = []
    for (let r = 0; r <= range.e.r; r++) {
      const row: string[] = []
      for (let c = range.s.c; c <= range.e.c; c++) row.push(r < range.s.r ? '' : xlsxCellText(sheet[XLSX.utils.encode_cell({ r, c })]))
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

// Client-side normalisation only. Anything unrecognised is passed through unchanged so the
// server's validation (the authority) rejects it with a row-specific message.
function normNumber(value: string) {
  const v = value.replace(/\s/g, '')
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) return v.replace(/,/g, '')
  if (/^\.\d+$/.test(v)) return `0${v}`
  return v
}
function splitQuantity(value: string): [string, string] {
  const match = value.trim().match(/^([\d.,]+)\s*([A-Za-zµμ]+)$/)
  return match ? [match[1], match[2]] : [value, '']
}
const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
function normDate(value: string) {
  const v = value.trim()
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`
  m = v.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,4})[a-z]*[-\s/,]+(\d{4})$/)
  if (m && months[m[2].toLowerCase()]) return `${m[3]}-${pad(months[m[2].toLowerCase()])}-${pad(Number(m[1]))}`
  return v // dd/mm/yyyy vs mm/dd/yyyy is ambiguous; let the server reject it
}

export function buildRows(sheet: Sheet, mapping: Mapping): ImportRow[] {
  const get = (cells: string[], key: FieldKey) => { const index = mapping[key]; return index == null ? '' : (cells[index] ?? '').trim() }
  return sheet.rows.map(({ rowNumber, cells }) => {
    let quantity = get(cells, 'current_quantity'), unit = get(cells, 'quantity_unit')
    if (!unit) [quantity, unit] = splitQuantity(quantity)
    let size = get(cells, 'bottle_size'), sizeUnit = get(cells, 'bottle_size_unit')
    if (size && !sizeUnit) [size, sizeUnit] = splitQuantity(size)
    let room = get(cells, 'location'), cabinet = get(cells, 'cabinet'), shelf = get(cells, 'shelf'), tray = get(cells, 'tray')
    // "R1 / Cabinet A / Shelf 1 / T1" is the app's own location format.
    if (room.includes('/') && !cabinet && !shelf) { const parts = room.split('/').map(part => part.trim()).filter(Boolean); room = parts[0] ?? ''; cabinet = parts[1] ?? ''; shelf = parts[2] ?? ''; tray = tray || (parts[3] ?? '') }
    const raw: Record<string, string> = {}; sheet.headers.forEach((header, index) => { if (cells[index]) raw[header] = cells[index] })
    const expiry = get(cells, 'expiry_date'), purchase = get(cells, 'purchase_date'), initial = get(cells, 'initial_quantity')
    return {
      row_number: rowNumber, raw,
      chemical_name: get(cells, 'chemical_name'), cas_number: get(cells, 'cas_number'), manufacturer: get(cells, 'manufacturer'), supplier: get(cells, 'supplier'), bottle_id: get(cells, 'bottle_id'),
      current_quantity: quantity ? normNumber(quantity) : '', quantity_unit: unit, bottle_size: size ? normNumber(size) : '', bottle_size_unit: sizeUnit, initial_quantity: initial ? normNumber(initial) : '',
      room, cabinet, shelf, tray, expiry_date: expiry ? normDate(expiry) : '', purchase_date: purchase ? normDate(purchase) : '',
      batch_lot_number: get(cells, 'batch_lot_number'), catalog_number: get(cells, 'catalog_number'), purity: get(cells, 'purity'), grade: get(cells, 'grade'), notes: get(cells, 'notes'),
    }
  })
}

export function downloadTemplate() {
  // Headers only; no sample records.
  const sheet = XLSX.utils.aoa_to_sheet([['Chemical Name', 'CAS Number', 'Bottle ID', 'Available Quantity', 'Unit', 'Bottle Size', 'Bottle Size Unit', 'Manufacturer', 'Supplier', 'Location', 'Tray Number', 'Expiry Date', 'Lot Number', 'Notes']])
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Inventory'); XLSX.writeFile(book, 'labventory-import-template.xlsx')
}
