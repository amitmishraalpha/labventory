// Browser test of the solvent tabs, usage + corrections, low stock, ordering, exports and permissions,
// against the real app (Vite dev) + mock Supabase + PGlite. Never touches production.
// node tests/ui/features.e2e.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const XLSX = createRequire(import.meta.url)('xlsx') // CommonJS build: readFile/writeFile need Node's fs
import { chromium } from 'playwright-core'
import { runner, assert } from '../db/harness.mjs'
import { startApp } from './run-app.mjs'

// 30 chemical bottles (more than one page) as the earlier register import left them.
const seed = ({ ADMIN }) => {
  const rows = Array.from({ length: 30 }, (_, i) => i + 1)
  return `insert into public.chemicals (id, name) select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'Reagent ' || lpad(n::text, 2, '0') from unnest(array[${rows}]) n;
    insert into public.bottles (id, bottle_id, chemical_id, bottle_size, bottle_size_unit, current_quantity, initial_quantity, quantity_unit, manufacturer, status)
      select ('10000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'B' || lpad(n::text, 3, '0'), ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 100, 'g', case when n = 7 then 10 else 50 end, 100, 'g', 'SRL', case when n = 7 then 'Low Stock' else 'Available' end::public.bottle_status from unnest(array[${rows}]) n;
    insert into public.transactions (bottle_id, chemical_id, user_id, transaction_type, quantity_before, quantity_change, quantity_after)
      select id, chemical_id, '${ADMIN}', 'STOCK_IN', 0, current_quantity, current_quantity from public.bottles;`
}

// Same layout and values as "lab inventory additional tabs.xlsx".
function solventWorkbook(path) {
  const cells = { A1: 'Commercial Solvents', I1: 'D Solvents', B2: 'Pack size', C2: 'No. of Cans', D2: 'Make', E2: 'Location', I3: 'Solvent', J3: 'Pack size', K3: 'bottles', L3: 'Bottle ID ', M3: 'Location', N3: 'Available Qty', O3: 'Last used by ' }
  const commercial = [['Hexane', 'Lab'], ['Ethyl acetate', 'Solvent room'], ['Chloroform', 'Lab'], ['Methanol', 'Solvent room'], ['Acetone', 'Lab'], ['ACN', 'Solvent room'], ['THF', 'Lab'], ['DCM', 'Solvent room'], ['Ethylene Glycol', 'Lab']]
  commercial.forEach(([name, place], i) => Object.assign(cells, { [`A${i + 3}`]: name, [`B${i + 3}`]: '25 lit', [`C${i + 3}`]: 1, [`D${i + 3}`]: 'Sannidhhi', [`E${i + 3}`]: place }))
  const nmr = [['CDCl3', '100ml', 2, 'CD01', '80ml'], ['DMSO-d6', '25ml ', 1, 'DM01', '5ml'], ['D2O', '25ml ', 1, 'DO01', '20ml'], ['CAN-d3', '10ml', 1, 'CN01', '25ml']]
  nmr.forEach(([name, pack, n, id, qty], i) => Object.assign(cells, { [`I${i + 4}`]: name, [`J${i + 4}`]: pack, [`K${i + 4}`]: n, [`L${i + 4}`]: id, [`M${i + 4}`]: 'Z1', [`N${i + 4}`]: qty }))
  const sheet = { '!ref': 'A1:O11' }
  for (const [ref, value] of Object.entries(cells)) sheet[ref] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value }
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Sheet1'); XLSX.writeFile(book, path)
}

const work = mkdtempSync(join(tmpdir(), 'labventory-ui-'))
const sheetPath = join(work, 'lab inventory additional tabs.xlsx'); solventWorkbook(sheetPath)
const app = await startApp({ beforeMigrations: seed })
const { db, base: BASE } = app
const { check, done } = runner('features (browser)')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } })
const page = await context.newPage()
const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message))
const T = { timeout: 15000 }
const sidebar = page.locator('aside.sidebar')
const login = async email => { await page.goto(BASE); await page.getByPlaceholder('you@lab.org').fill(email); await page.getByPlaceholder('Enter your password').fill('test-password'); await page.getByRole('button', { name: 'Sign in' }).click(); await sidebar.waitFor(T) }
const signOut = async () => { await sidebar.getByRole('button', { name: 'Sign out' }).click(); await page.getByRole('button', { name: 'Sign in' }).waitFor(T) }
const go = async label => { await sidebar.getByRole('link', { name: label }).click() }
const one = async (sql, params) => (await db.query(sql, params)).rows[0]
const exportFile = async (format, scope) => {
  const menu = page.locator('.export-menu').first(); await menu.getByRole('button', { name: /Export/ }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), menu.locator('.export-scope', { hasText: scope }).getByRole('menuitem', { name: format }).click()])
  const path = join(work, download.suggestedFilename()); await download.saveAs(path)
  const book = XLSX.readFile(path); return { name: download.suggestedFilename(), rows: XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]), sheets: book.SheetNames }
}
const modal = () => page.locator('.modal')

try {
  // ---------------------------------------------------------------- Admin: import the solvent sheet
  await login('admin@lab.test')
  await check('new tabs in the sidebar', async () => { for (const label of ['Commercial Solvents', 'NMR Solvents', 'Low Stock', 'Chemicals to Order', 'Usage History']) await sidebar.getByRole('link', { name: label }).waitFor(T) })
  await check('solvent import: preview, server check, import 14 cans/bottles', async () => {
    await go('Research Management'); await page.getByRole('button', { name: 'Import', exact: true }).click()
    await page.locator('input[type=file][accept=".xlsx"]').setInputFiles(sheetPath)
    await page.getByText('→ 14 cans/bottles').waitFor(T)
    await page.getByRole('button', { name: 'Check with the database' }).click()
    await page.getByText(/Ready: 14 new, 0 already imported, 11 without a checked amount/).waitFor(T)
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'Import 14 cans/bottles' }).click()
    await page.getByText(/Imported 14 cans\/bottles/).waitFor(T)
    const n = await one(`select count(*)::int n from public.bottles where inventory_category <> 'CHEMICAL'`)
    assert(n.n === 14, `${n.n} solvent bottles`)
  })
  await check('NMR tab: CDCl3 shows 2 bottles, total 80 mL + 1 not yet checked; CAN-d3 needs review', async () => {
    await go('NMR Solvents')
    const row = page.locator('tbody tr', { hasText: 'CDCl3' }).first()
    await row.getByText('80 mL').waitFor(T); await row.getByText('+ 1 bottle not yet checked').waitFor(T); await row.getByText('2 of 2').waitFor(T)
    await page.locator('tbody tr', { hasText: 'CAN-d3' }).first().getByText('Needs review').waitFor(T)
  })
  await check('Admin enters the counted amount for a Hexane can (Needs review -> 20 L)', async () => {
    await go('Commercial Solvents'); await page.locator('tbody tr', { hasText: 'Hexane' }).first().click()
    await page.getByRole('button', { name: 'Stock count of CS-HEXANE-01' }).click()
    await modal().locator('input[type=number]').fill('20'); await modal().locator('input:not([type=number])').fill('Dipstick 31 Oct')
    page.once('dialog', dialog => dialog.accept()); await modal().getByRole('button', { name: 'Save amount' }).click()
    await page.getByText('CS-HEXANE-01: remaining amount set to 20 L.').waitFor(T)
    await page.locator('tr', { hasText: 'CS-HEXANE-01' }).getByText('20 L').first().waitFor(T)
  })
  await check('Admin edits the make; edit is audited, quantity unchanged', async () => {
    await page.getByRole('button', { name: 'Edit CS-HEXANE-01' }).click()
    const make = modal().locator('label', { hasText: 'Make / manufacturer' }).locator('input'); await make.fill('Sannidhi Chemicals')
    await modal().getByRole('button', { name: 'Save changes' }).click(); await page.getByText('Saved changes to CS-HEXANE-01.').waitFor(T)
    const b = await one(`select manufacturer, current_quantity from public.bottles where bottle_id = 'CS-HEXANE-01'`)
    assert(b.manufacturer === 'Sannidhi Chemicals' && Number(b.current_quantity) === 20, JSON.stringify(b))
  })
  await signOut()

  // ---------------------------------------------------------------- Researcher: usage, history, correction
  await login('res@lab.test')
  await check('researcher: no Research Management, no Edit / Stock count buttons', async () => {
    assert(!(await sidebar.getByRole('link', { name: 'Research Management' }).count()), 'admin link visible')
    await go('NMR Solvents'); await page.locator('tbody tr', { hasText: 'CDCl3' }).first().click()
    await page.getByRole('button', { name: 'Record usage of CD01' }).waitFor(T)
    assert(!(await page.getByRole('button', { name: 'Edit CD01' }).count()) && !(await page.getByRole('button', { name: 'Stock count of CD01' }).count()), 'admin buttons visible')
    assert(await page.getByRole('button', { name: 'Record usage of CD02' }).isDisabled(), 'usage allowed on an unchecked bottle')
  })
  await check('record usage with review step: 5 mL of CD01 -> 75 mL, last used by You', async () => {
    await page.getByRole('button', { name: 'Record usage of CD01' }).click()
    await modal().getByPlaceholder('e.g. 5').fill('5'); await modal().getByPlaceholder('Project A, batch 12').fill('Project A')
    await modal().getByRole('button', { name: 'Review' }).click()
    await modal().getByText('Check before saving').waitFor(T); await modal().getByText('75 mL').waitFor(T)
    await modal().getByRole('button', { name: 'Confirm and save' }).click()
    await page.getByText(/Recorded 5 mL of CDCl3 \(CD01\)\. 75 mL left\./).waitFor(T)
    const row = page.locator('tr', { hasText: 'CD01' }).last(); await row.getByText('75 mL').first().waitFor(T); await row.getByText('Ravi Researcher').waitFor(T)
  })
  await check('bottle history: initial 100 / consumed 5 / before tracking 20 / remaining 75', async () => {
    await page.getByRole('button', { name: 'Usage history of CD01' }).click()
    const figures = modal().locator('.figures'); for (const text of ['100 mL', '5 mL', '20 mL', '75 mL']) await figures.getByText(text, { exact: true }).waitFor(T)
    await modal().getByText('Project A').waitFor(T)
    await modal().getByRole('button', { name: 'Close' }).click()
  })
  await check('researcher corrects own entry 5 -> 7 mL with reason; original kept', async () => {
    await go('Usage History'); await page.locator('tbody tr', { hasText: 'CD01' }).getByRole('button', { name: 'Correct' }).click()
    await modal().locator('input[type=number]').fill('7'); await modal().locator('label', { hasText: 'Reason for correction' }).locator('input').fill('Misread the syringe')
    await modal().getByRole('button', { name: 'Review correction' }).click(); await modal().getByRole('button', { name: 'Save correction' }).click()
    await page.getByText(/Corrected CDCl3 \(CD01\): 5 → 7 mL\. 73 mL left/).waitFor(T)
    await page.locator('tbody tr', { hasText: 'CD01' }).getByText('Corrected (recorded 5 mL)').waitFor(T)
    const t = await one(`select count(*)::int n, min(quantity_change) q from public.transactions where transaction_type = 'USAGE'`)
    assert(t.n === 1 && Number(t.q) === -5, 'original transaction unchanged')
  })
  await check('usage history export: CSV of all matching entries', async () => {
    const file = await exportFile('CSV', 'All matching entries')
    assert(/^usage-history_.*\.csv$/.test(file.name) && file.rows.length === 1 && file.rows[0]['Quantity consumed'] === 7 && file.rows[0]['Originally recorded'] === 5, JSON.stringify(file.rows[0]))
  })
  await check('low stock: CD01 used down to 15 mL appears; Add to order list prefills the request', async () => {
    const b = await one(`select id from public.bottles where bottle_id = 'CD01'`)
    await app.as((await one(`select id from public.profiles where email = 'res@lab.test'`)).id, () => db.query(`select public.record_usage($1, 58, 'mL')`, [b.id]))
    await page.reload(); await go('Low Stock')
    const row = page.locator('tbody tr', { hasText: 'CD01' }); await row.getByText('15 mL').waitFor(T); await row.getByText('20 mL').waitFor(T)
    await row.getByRole('button', { name: 'Add to order list' }).click()
    await modal().getByText('Chemical to be ordered').waitFor(T)
    assert(await modal().locator('label', { hasText: 'Chemical name' }).locator('input').inputValue() === 'CDCl3', 'name prefilled')
    assert(/Low stock: 15 mL left in CD01/.test(await modal().locator('label', { hasText: 'Reason for request' }).locator('input').inputValue()), 'reason prefilled')
    await modal().getByRole('button', { name: 'Submit request' }).click(); await page.getByText('CDCl3 was added to the order list').waitFor(T)
    await page.locator('tbody tr', { hasText: 'CDCl3' }).getByText('Requested').waitFor(T)
  })
  await check('duplicate open request warns and needs confirmation', async () => {
    await page.getByRole('button', { name: 'Add chemical to order' }).click()
    await modal().locator('label', { hasText: 'Chemical name' }).locator('input').fill('cdcl3'); await modal().locator('label', { hasText: 'Quantity needed' }).locator('input').fill('50')
    await modal().getByRole('button', { name: 'Submit request' }).click(); await modal().getByText(/already on the order list/).waitFor(T)
    await modal().getByRole('button', { name: "Don't add" }).click()
    assert((await one(`select count(*)::int n from public.chemical_order_requests`)).n === 1, 'duplicate was saved')
  })
  await signOut()

  // ---------------------------------------------------------------- Admin: approve, order, receive
  await login('admin@lab.test')
  await check('admin approves, marks ordered and receives a bottle (stock-in, new bottle in NMR tab)', async () => {
    await go('Chemicals to Order'); const row = () => page.locator('tbody tr', { hasText: 'CDCl3' }).first()
    await row().getByRole('button', { name: 'Approve' }).click(); await modal().getByRole('button', { name: 'Approve' }).click(); await page.getByText('CDCl3: approved.').waitFor(T)
    await row().getByRole('button', { name: 'Mark ordered' }).click(); await modal().locator('label', { hasText: 'Supplier' }).first().locator('input').fill('Sigma-Aldrich'); await modal().getByRole('button', { name: 'Mark as ordered' }).click(); await page.getByText('CDCl3: marked as ordered.').waitFor(T)
    await row().getByRole('button', { name: 'Receive' }).click()
    await modal().locator('label', { hasText: 'New Bottle ID' }).locator('input').fill('CD03'); await modal().locator('label', { hasText: 'Quantity received' }).locator('input').fill('100')
    await modal().getByRole('button', { name: 'Review' }).click(); await modal().getByText('Existing: CDCl3').waitFor(T); await modal().getByRole('button', { name: 'Receive into inventory' }).click()
    await page.getByText(/Received 100 mL of CDCl3 as bottle CD03 \(now Received\)/).waitFor(T)
    const tx = await one(`select t.transaction_type, b.inventory_category from public.transactions t join public.bottles b on b.id = t.bottle_id where b.bottle_id = 'CD03'`)
    assert(tx.transaction_type === 'STOCK_IN' && tx.inventory_category === 'NMR_SOLVENT', JSON.stringify(tx))
    await go('NMR Solvents'); await page.locator('tbody tr', { hasText: 'CDCl3' }).first().getByText('3 of 3').waitFor(T)
  })
  await check('admin sees the researcher\'s correction in the usage history with reason', async () => {
    await go('Usage History'); await page.locator('tbody tr', { hasText: 'CD01' }).filter({ hasText: 'Corrected' }).getByRole('button', { name: /1 correction/ }).click()
    await page.getByText('Reason: Misread the syringe').waitFor(T)
  })
  await check('master inventory export: all 30 bottles; filtered search exports all matches across pages', async () => {
    await go('Inventory'); await page.getByText('1–25 of 30 bottles').waitFor(T)
    const all = await exportFile('Excel', 'Export all inventory')
    assert(all.rows.length === 30 && all.sheets.includes('About') && 'Last used by' in all.rows[0] && 'Bottle ID' in all.rows[0], `${all.rows.length} rows ${Object.keys(all.rows[0])}`)
    await page.getByPlaceholder(/Search by chemical name/).fill('Reagent')
    const matching = await exportFile('CSV', 'Export current filtered results'); assert(matching.rows.length === 30, `${matching.rows.length} matching rows`)
    const current = await exportFile('CSV', 'Export current page'); assert(current.rows.length === 25, `${current.rows.length} page rows`)
    await page.getByPlaceholder(/Search by chemical name/).fill('Reagent 1')
    const ten = await exportFile('Excel', 'Export current filtered results'); assert(ten.rows.length === 10, `${ten.rows.length} rows for "Reagent 1"`) // Reagent 10-19
  })
  await check('low-stock export lists threshold, shortfall and source', async () => {
    await go('Low Stock'); await page.locator('tbody tr', { hasText: 'B007' }).waitFor(T)
    const file = await exportFile('Excel', 'All matching low-stock items')
    const b007 = file.rows.find(r => r['Bottle ID'] === 'B007')
    assert(b007 && b007['Current quantity'] === 10 && b007['Low-stock threshold'] === 20 && b007.Shortfall === 10 && /default/.test(b007['Threshold source']), JSON.stringify(b007))
  })
  await check('dashboard cards count solvents, low stock and orders from the database', async () => {
    await go('Overview')
    const stat = label => page.locator('.stat', { hasText: label }).locator('strong')
    await page.waitForFunction(() => document.querySelector('.stats')?.textContent?.includes('NMR solvent bottles'))
    assert(await stat('Commercial solvent cans').textContent() === '9', 'cans'); assert(await stat('NMR solvent bottles').textContent() === '6', 'nmr')
    assert(await stat('Chemicals to be ordered').textContent() === '0', 'open orders')
  })
  await check('no uncaught page errors', async () => { assert(!pageErrors.length, pageErrors.join(' | ')) })
} finally {
  await browser.close(); await app.stop(); done(); setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}
