import * as XLSX from 'xlsx'

export type ExportColumn<T> = { header: string; value: (row: T) => string | number | null | undefined }
export type ExportFormat = 'csv' | 'xlsx'

const stamp = (date: Date) => date.toISOString().slice(0, 16).replace('T', '_').replace(':', '-')

/** Builds the sheet rows (header order preserved). Exported for tests. */
export function exportTable<T>(columns: ExportColumn<T>[], rows: T[]) {
  return rows.map(row => Object.fromEntries(columns.map(column => { const value = column.value(row); return [column.header, value ?? ''] })))
}

/**
 * Downloads `rows` as CSV or Excel. Rows are the records the user can already see (RLS applies to the
 * queries that loaded them), so nothing outside their access is ever exported. The Excel file gets an
 * "About" sheet with the generation time and the filter that produced it.
 */
export function downloadRows<T>(baseName: string, columns: ExportColumn<T>[], rows: T[], format: ExportFormat, description: string) {
  const generated = new Date()
  const data = exportTable(columns, rows)
  const sheet = XLSX.utils.json_to_sheet(data, { header: columns.map(column => column.header) })
  sheet['!cols'] = columns.map(column => ({ wch: Math.min(48, Math.max(column.header.length + 2, ...data.slice(0, 200).map(row => String(row[column.header] ?? '').length + 1))) }))
  const fileName = `${baseName}_${stamp(generated)}.${format}`
  if (format === 'csv') {
    // BOM so Excel opens µ and other non-ASCII characters correctly.
    const blob = new Blob(['﻿' + XLSX.utils.sheet_to_csv(sheet)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = fileName
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  } else {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, sheet, 'Data')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Generated', generated.toLocaleString('en-GB')], ['Contents', description], ['Rows', rows.length], ['Source', 'Labventory (live Supabase records)']]), 'About')
    XLSX.writeFile(book, fileName)
  }
  return fileName
}

export const fmtDate = (value: string | null | undefined) => (value ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
export const fmtDateTime = (value: string | null | undefined) => (value ? new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
