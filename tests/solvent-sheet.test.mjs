// node --experimental-strip-types tests/solvent-sheet.test.mjs "<path to lab inventory additional tabs.xlsx>"
import { readFileSync } from 'node:fs'
import { gridFromWorkbook, parseSolventGrid } from '../src/import/solventSheet.ts'
import { runner, assert } from './db/harness.mjs'

const file = process.argv[2]
const { check, done } = runner('solvent sheet parser')
const buffer = readFileSync(file)
const parsed = parseSolventGrid(gridFromWorkbook(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)))
const by = id => parsed.rows.find(r => r.bottle_id === id)
await check('two sections found with the original row counts (9 commercial, 4 NMR)', () => {
  assert(parsed.sections.length === 2 && parsed.sections[0].sourceRows === 9 && parsed.sections[1].sourceRows === 4, JSON.stringify(parsed.sections))
})
await check('one row per physical can/bottle (9 cans + 5 NMR bottles)', () => {
  assert(parsed.rows.filter(r => r.category === 'COMMERCIAL_SOLVENT').length === 9 && parsed.rows.filter(r => r.category === 'NMR_SOLVENT').length === 5, `${parsed.rows.length} rows`)
})
await check('commercial cans: pack 25 lit kept, no amount assumed, generated IDs flagged', () => {
  const hex = parsed.rows.find(r => r.name === 'Hexane')
  assert(hex.pack_size === '25' && hex.pack_unit === 'lit' && hex.quantity === '' && hex.generated_id && hex.bottle_id === 'CS-HEXANE-01' && hex.make === 'Sannidhhi' && hex.place === 'Lab', JSON.stringify(hex))
  assert(hex.raw.pack_size === '25 lit' && hex.raw.section === 'Commercial Solvents', 'raw kept')
})
await check('CDCl3: CD01 keeps 80 ml; second bottle CD02 has no amount and is flagged', () => {
  const a = by('CD01'), b = by('CD02')
  assert(a && a.quantity === '80' && a.quantity_unit === 'ml' && !a.generated_id, JSON.stringify(a))
  assert(b && b.quantity === '' && b.generated_id && /one available quantity/.test(b.flag), JSON.stringify(b))
})
await check('CAN-d3 label preserved and flagged; 25ml available kept for the server to check', () => {
  const c = by('CN01')
  assert(c.name === 'CAN-d3' && /verify/.test(c.flag) && c.quantity === '25' && c.pack_size === '10', JSON.stringify(c))
})
await check('no parser problems on the real sheet; no last-used values invented', () => {
  assert(parsed.problems.length === 0, parsed.problems.join('; '))
  assert(parsed.rows.every(r => r.legacy_last_used_by === ''), 'last used by is empty in the sheet')
})
done()
