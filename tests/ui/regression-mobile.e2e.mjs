// Existing features still work after the solvent/order release, and every page fits a phone screen.
// node tests/ui/regression-mobile.e2e.mjs   (WebKit: PLAYWRIGHT_BROWSERS_PATH must point at an installed WebKit)
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, webkit, devices } from 'playwright-core'
import { runner, assert } from '../db/harness.mjs'
import { startApp } from './run-app.mjs'

const seed = ({ ADMIN }) => `insert into public.chemicals (id, name, cas_number) values ('00000000-0000-0000-0000-000000000001', '2-Chloroacetophenone', '532-27-4');
  insert into public.bottles (id, bottle_id, chemical_id, bottle_size, bottle_size_unit, current_quantity, initial_quantity, quantity_unit, manufacturer, status)
  values ('10000000-0000-0000-0000-000000000001', 'B001', '00000000-0000-0000-0000-000000000001', 25, 'g', 15, 25, 'g', 'SRL', 'Available');
  insert into public.transactions (bottle_id, chemical_id, user_id, transaction_type, quantity_before, quantity_change, quantity_after) values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '${ADMIN}', 'STOCK_IN', 0, 15, 15);`
const app = await startApp({ beforeMigrations: seed, mockPort: 54331, vitePort: 5201 })
const { db, base: BASE } = app
// A solvent can and an NMR bottle so the new tabs have content on phones.
await db.exec(`select set_config('request.jwt.claim.sub', (select id::text from public.profiles where email = 'admin@lab.test'), false);
  select public.create_inventory_item('{"category":"COMMERCIAL_SOLVENT","chemical_name":"Hexane","bottle_id":"CS-HEXANE-01","bottle_size":"25","unit":"L","manufacturer":"Sannidhhi","place":"Lab"}');
  select public.create_inventory_item('{"category":"NMR_SOLVENT","chemical_name":"CDCl3","bottle_id":"CD01","bottle_size":"100","unit":"mL","quantity":"80","place":"Z1"}');
  select set_config('request.jwt.claim.sub', '', false);`)
const { check, done } = runner('regression + mobile (browser)')
const T = { timeout: 15000 }
const signIn = async (page, email) => { await page.goto(BASE); await page.getByPlaceholder('you@lab.org').fill(email); await page.getByPlaceholder('Enter your password').fill('test-password'); await page.getByRole('button', { name: 'Sign in' }).click(); await page.locator('aside.sidebar').waitFor({ state: 'attached', ...T }) }

try {
  // ---------------------------------------------------------------- desktop regression (Chrome)
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); const page = await browser.newPage({ viewport: { width: 1300, height: 900 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await signIn(page, 'res@lab.test')
  await check('researcher: /admin redirects to Overview; name shown in sidebar', async () => {
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' }); await page.getByText(/Good (morning|afternoon|evening), Ravi/).waitFor(T)
    assert(page.url() === `${BASE}/`, page.url())
  })
  await check('inventory: CAS search, PubChem link and record usage (old register bottle)', async () => {
    await page.goto(`${BASE}/inventory`, { waitUntil: 'domcontentloaded' }); await page.getByPlaceholder(/Search by chemical name/).fill('532274')
    const row = page.locator('tbody tr', { hasText: '2-Chloroacetophenone' }); await row.locator('a.pubchem-link').waitFor(T)
    await row.getByRole('button', { name: /Record usage of/ }).click(); await page.getByPlaceholder('e.g. 5').fill('500'); await page.locator('.modal select').selectOption('mg')
    await page.getByRole('button', { name: 'Review' }).click(); await page.getByRole('button', { name: 'Confirm and save' }).click()
    await page.getByText(/14\.5 g left/).waitFor(T)
  })
  await check('chemicals page groups by make and expands bottles', async () => {
    await page.goto(`${BASE}/chemicals`, { waitUntil: 'domcontentloaded' }); await page.locator('tbody tr', { hasText: '2-Chloroacetophenone' }).first().click(); await page.getByText('Bottle 1 of 1').waitFor(T)
  })
  await check('flash chromatography: book a 1-hour slot', async () => {
    await page.goto(`${BASE}/flash`, { waitUntil: 'domcontentloaded' }); await page.getByRole('heading', { name: 'Flash chromatography' }).waitFor(T)
    await page.getByRole('button', { name: 'Next day' }).click()
    await page.locator('.slot-pick', { hasText: 'Available' }).first().click()
    await page.getByRole('button', { name: /^Book \d/ }).click(); await page.getByText(/^Booked /).first().waitFor(T)
    assert((await db.query(`select count(*)::int n from public.flash_bookings`)).rows[0].n === 1, 'no booking saved')
  })
  await check('flash chromatography: evening slots to 22:00 are shown and the 21:00 slot books as 21:00 IST', async () => {
    const times = await page.locator('.slot-time').allInnerTexts()
    assert(times.length === 13 && times[0].includes('09:00 – 10:00') && times[12].includes('21:00 – 22:00'), times.join(' | '))
    await page.locator('.slot', { hasText: '21:00 – 22:00' }).locator('.slot-pick').click()
    await page.getByRole('button', { name: 'Book 21:00–22:00' }).click(); await page.getByText(/^Booked 21:00–22:00/).waitFor(T)
    const r = (await db.query(`select to_char(slot_start at time zone 'Asia/Kolkata', 'HH24:MI') s, to_char(slot_end at time zone 'Asia/Kolkata', 'HH24:MI') e from public.flash_bookings order by slot_start desc limit 1`)).rows[0]
    assert(r.s === '21:00' && r.e === '22:00', JSON.stringify(r))
    await page.locator('.slot', { hasText: '21:00 – 22:00' }).getByText('You').waitFor(T)
  })
  await page.locator('aside.sidebar').getByRole('button', { name: 'Sign out' }).click(); await page.getByRole('button', { name: 'Sign in' }).waitFor(T)
  await signIn(page, 'admin@lab.test')
  await check('admin: researcher list, chemical register import (dry run) and activity log', async () => {
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' }); await page.getByText('All researchers').waitFor(T)
    await page.goto(`${BASE}/admin?tab=import`, { waitUntil: 'domcontentloaded' })
    const dir = mkdtempSync(join(tmpdir(), 'lv-')); const csv = join(dir, 'register.csv')
    writeFileSync(csv, 'S.No,Chemical Name,Name_imported_from_Cas No,Cas No,Make,Bottle size,Approx avilable quantity (g/mL),Place,Tray No\n1,Benzaldehyde,,100-52-7,Merck,100 mL,40 mL,R2,T4\n')
    await page.locator('input[type=file][accept=".csv,.xlsx"]').setInputFiles(csv)
    await page.getByRole('button', { name: /^Validate 1 bottle/ }).click(); await page.getByRole('button', { name: /^Import 1 bottle/ }).waitFor(T)
    await page.goto(`${BASE}/admin?tab=activity`, { waitUntil: 'domcontentloaded' }); await page.getByText('Usage recorded').first().waitFor(T)
  })
  await check('no uncaught page errors (desktop)', async () => assert(!errors.length, errors.join(' | ')))
  await browser.close()

  // ---------------------------------------------------------------- phones: every page fits without sideways scrolling
  const shots = mkdtempSync(join(tmpdir(), 'labventory-shots-'))
  const targets = [['iPhone 13', webkit, devices['iPhone 13']], ['Pixel 7', chromium, devices['Pixel 7']]]
  for (const [name, engine, device] of targets) {
    let phone
    try { phone = await engine.launch(engine === chromium ? { channel: 'chrome', headless: true } : { headless: true }) }
    catch (error) { await check(`${name}: browser available`, () => { throw new Error(error.message.split('\n')[0]) }); continue }
    const page = await (await phone.newContext({ ...device })).newPage()
    await signIn(page, 'admin@lab.test')
    for (const path of ['/', '/inventory', '/chemicals', '/commercial-solvents', '/nmr-solvents', '/low-stock', '/orders', '/usage', '/flash', '/admin']) {
      await check(`${name}: ${path} fits the screen`, async () => {
        await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }); await page.locator('.content h1, .content h2').first().waitFor(T); await page.waitForTimeout(400)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        await page.screenshot({ path: join(shots, `${name.replace(' ', '')}${path.replace(/\//g, '_') || '_'}.png`), fullPage: false })
        assert(overflow <= 1, `page is ${overflow}px wider than the screen`)
      })
    }
    await check(`${name}: NMR record-usage sheet opens and fits`, async () => {
      await page.goto(`${BASE}/nmr-solvents`, { waitUntil: 'domcontentloaded' }); await page.locator('tbody tr', { hasText: 'CDCl3' }).first().click()
      await page.getByRole('button', { name: 'Record usage of CD01' }).click(); await page.locator('.modal').waitFor(T)
      const box = await page.locator('.modal').boundingBox(); const width = page.viewportSize().width
      await page.screenshot({ path: join(shots, `${name.replace(' ', '')}_usage-sheet.png`) })
      assert(box && box.x >= -1 && box.x + box.width <= width + 1, `modal ${JSON.stringify(box)} vs ${width}`)
    })
    await phone.close()
  }
  console.log(`screenshots: ${shots}`)
} finally {
  await app.stop(); done(); setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}
