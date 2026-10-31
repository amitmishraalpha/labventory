// Database tests for 20261031090000_solvents_corrections_orders.sql, run against the isolated replica.
// node tests/db/solvents-orders.test.mjs
import { setupDb, runner, assert, rejects } from './harness.mjs'

const MIGRATION = 'supabase/migrations/20261031090000_solvents_corrections_orders.sql'
// A legacy chemical bottle exactly as the earlier spreadsheet import left it (25 g bottle, 15 g at import).
const legacy = ({ ADMIN }) => `insert into public.chemicals (id, name, cas_number) values ('11111111-1111-1111-1111-111111111111', 'Acetone', '67-64-1');
  insert into public.bottles (id, bottle_id, chemical_id, bottle_size, bottle_size_unit, current_quantity, initial_quantity, quantity_unit, status)
  values ('22222222-2222-2222-2222-222222222222', 'LEG-1', '11111111-1111-1111-1111-111111111111', 25, 'g', 15, 25, 'g', 'Available');
  insert into public.transactions (bottle_id, chemical_id, user_id, transaction_type, quantity_before, quantity_change, quantity_after)
  values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', '${ADMIN}', 'STOCK_IN', 0, 15, 15);`
const { db, ADMIN, ADMIN2, RES, RES2, as } = await setupDb({ migrations: [MIGRATION], beforeMigrations: legacy })
const { check, done } = runner('solvents, corrections and orders')
const one = async (user, sql, params = []) => (await as(user, () => db.query(sql, params))).rows[0]
const rpc = async (user, fn, args) => {
  const names = Object.keys(args), values = Object.values(args)
  const row = await one(user, `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`, values)
  return row.r
}
const bottle = async code => (await db.query('select * from public.bottles where bottle_id = $1', [code])).rows[0]
const num = value => value == null ? null : Number(value)

// ---------------------------------------------------------------- 1, 2: creation and editing
await check('1. Admin creates a commercial solvent can (25 L, amount unknown -> Needs review)', async () => {
  await rpc(ADMIN, 'create_inventory_item', { p: { category: 'COMMERCIAL_SOLVENT', chemical_name: 'Hexane', bottle_id: 'CS-HEXANE-01', bottle_size: '25', bottle_size_unit: 'L', unit: 'L', manufacturer: 'Sannidhhi', place: 'Lab' } })
  const b = await bottle('CS-HEXANE-01')
  assert(b.inventory_category === 'COMMERCIAL_SOLVENT', 'category')
  assert(b.current_quantity === null, 'quantity should be unknown, not assumed full')
  assert(num(b.initial_quantity) === 25 && b.quantity_unit === 'L', 'initial = pack size')
  const tx = await db.query(`select count(*)::int n from public.transactions where bottle_id = $1`, [b.id])
  assert(tx.rows[0].n === 0, 'no stock-in for an unknown amount')
})
await check('1. Admin enters the counted amount; it becomes usable (STOCK_IN, untracked difference)', async () => {
  const b = await bottle('CS-HEXANE-01')
  await rpc(ADMIN, 'set_verified_quantity', { p_bottle_id: b.id, p_quantity: 20, p_quantity_unit: 'L', p_reason: 'Measured by dipstick' })
  const after = await bottle('CS-HEXANE-01')
  assert(num(after.current_quantity) === 20 && num(after.untracked_quantity) === 5, `got ${after.current_quantity}/${after.untracked_quantity}`)
  const tx = (await db.query(`select transaction_type, quantity_change from public.transactions where bottle_id = $1`, [b.id])).rows
  assert(tx.length === 1 && tx[0].transaction_type === 'STOCK_IN' && num(tx[0].quantity_change) === 20, 'stock-in of the verified amount')
})
await check('1. Admin edits solvent details; change is audited; quantity untouched', async () => {
  const b = await bottle('CS-HEXANE-01')
  await rpc(ADMIN, 'update_inventory_item', { p_bottle_id: b.id, p_changes: { manufacturer: 'Sannidhi Chemicals', place: 'Solvent room', low_stock_threshold: '5', low_stock_threshold_unit: 'L' }, p_reason: 'Typo in make' })
  const after = await bottle('CS-HEXANE-01')
  assert(after.manufacturer === 'Sannidhi Chemicals' && num(after.low_stock_threshold) === 5, 'edited')
  assert(num(after.current_quantity) === 20, 'quantity unchanged')
  const log = (await db.query(`select metadata from public.activity_log where action_type = 'INVENTORY_EDITED' and bottle_id = $1`, [b.id])).rows[0]
  assert(log.metadata.before.manufacturer === 'Sannidhhi' && log.metadata.after.manufacturer === 'Sannidhi Chemicals' && log.metadata.reason === 'Typo in make', 'before/after audited')
})
await check('2. Admin creates NMR bottles CD01 (80 of 100 mL) and CD02 (unknown); separate rows, same chemical', async () => {
  await rpc(ADMIN, 'create_inventory_item', { p: { category: 'NMR_SOLVENT', chemical_name: 'CDCl3', bottle_id: 'CD01', bottle_size: '100', unit: 'mL', quantity: '80', place: 'Z1' } })
  await rpc(ADMIN, 'create_inventory_item', { p: { category: 'NMR_SOLVENT', chemical_name: 'CDCl3', bottle_id: 'CD02', bottle_size: '100', unit: 'mL', place: 'Z1' } })
  const a = await bottle('CD01'), b = await bottle('CD02')
  assert(a.id !== b.id && a.chemical_id === b.chemical_id, 'two bottles of one chemical')
  assert(num(a.current_quantity) === 80 && num(a.untracked_quantity) === 20 && num(a.initial_quantity) === 100, 'opening balance, 20 mL used before tracking')
})
await check('2. Duplicate Bottle ID is rejected (create and edit, case-insensitive)', async () => {
  await rejects(rpc(ADMIN, 'create_inventory_item', { p: { category: 'NMR_SOLVENT', chemical_name: 'CDCl3', bottle_id: 'cd01', bottle_size: '100', unit: 'mL' } }), /DUPLICATE_BOTTLE_ID/)
  const b = await bottle('CD02')
  await rejects(rpc(ADMIN, 'update_inventory_item', { p_bottle_id: b.id, p_changes: { bottle_id: 'CD01' } }), /DUPLICATE_BOTTLE_ID/)
})
await check('2. Edit rejects calculated fields and unknown keys', async () => {
  const b = await bottle('CD01')
  await rejects(rpc(ADMIN, 'update_inventory_item', { p_bottle_id: b.id, p_changes: { current_quantity: 100 } }), /FIELD_NOT_EDITABLE/)
  await rejects(rpc(ADMIN, 'update_inventory_item', { p_bottle_id: b.id, p_changes: { status: 'Low Stock' } }), /STATUS_NOT_SETTABLE/)
})

// ---------------------------------------------------------------- 3-7: usage
let usageId
await check('3/4/5. Researcher records 5 mL of CD01: remaining, totals, last used by/at/quantity', async () => {
  const b = await bottle('CD01')
  const r = await rpc(RES, 'record_usage', { p_bottle_id: b.id, p_quantity: 5, p_quantity_unit: 'mL', p_purpose: 'NMR of compound 7', p_experiment: 'Project A', p_notes: 'sample 3' })
  usageId = r.transaction_id
  const after = await bottle('CD01')
  assert(num(after.current_quantity) === 75 && num(after.total_used) === 5, `remaining ${after.current_quantity}`)
  assert(after.last_used_by === RES && after.last_used_at && num(after.last_used_quantity) === 5, 'last used fields')
  const h = await one(RES, `select * from public.usage_history where id = $1`, [usageId])
  assert(h.user_name === 'Ravi Researcher' && h.user_email === 'res@lab.test' && h.experiment === 'Project A' && num(h.quantity_before) === 80 && num(h.quantity_after) === 75, 'history row')
})
await check('3. Units convert (0.5 L from a 25 L can is recorded in L); mass on a volume bottle is refused', async () => {
  const b = await bottle('CS-HEXANE-01')
  await rpc(RES2, 'record_usage', { p_bottle_id: b.id, p_quantity: 500, p_quantity_unit: 'mL' })
  assert(num((await bottle('CS-HEXANE-01')).current_quantity) === 19.5, 'converted to L')
  await rejects(rpc(RES, 'record_usage', { p_bottle_id: b.id, p_quantity: 1, p_quantity_unit: 'g' }), /UNIT_MISMATCH/)
})
await check('5. Researchers see colleagues\' names in usage history (people_directory)', async () => {
  const rows = (await as(RES, () => db.query(`select user_name from public.usage_history order by created_at`))).rows
  assert(rows.some(r => r.user_name === 'Rita Researcher'), 'another researcher\'s name is visible')
})
await check('6. Usage larger than the remaining amount is refused; nothing changes', async () => {
  const b = await bottle('CD01')
  await rejects(rpc(RES, 'record_usage', { p_bottle_id: b.id, p_quantity: 76, p_quantity_unit: 'mL' }), /INSUFFICIENT_QUANTITY/)
  assert(num((await bottle('CD01')).current_quantity) === 75, 'unchanged')
})
await check('6. Usage on a Needs-review bottle is refused', async () => {
  const b = await bottle('CD02')
  await rejects(rpc(RES, 'record_usage', { p_bottle_id: b.id, p_quantity: 1, p_quantity_unit: 'mL' }), /QUANTITY_NOT_VERIFIED/)
})
await check('7. Separate physical bottles stay separate (usage on CD01 does not touch CD02)', async () => {
  const b = await bottle('CD02')
  assert(b.current_quantity === null && num(b.total_used) === 0, 'CD02 untouched')
})
await check('Low stock uses the configured threshold (Hexane: 5 L) and the 20% default (CD01)', async () => {
  const b = await bottle('CS-HEXANE-01')
  await rpc(RES, 'record_usage', { p_bottle_id: b.id, p_quantity: 15, p_quantity_unit: 'L' })
  assert((await bottle('CS-HEXANE-01')).status === 'Low Stock', '4.5 L < 5 L threshold')
  const c = await bottle('CD01')
  await rpc(RES, 'record_usage', { p_bottle_id: c.id, p_quantity: 56, p_quantity_unit: 'mL' })
  assert((await bottle('CD01')).status === 'Low Stock', '19 mL < 20% of 100 mL')
})

// ---------------------------------------------------------------- 8: corrections
await check('8. Researcher corrects own entry (5 -> 7 mL): original kept, adjustment + audit, balance reconciled', async () => {
  const before = await bottle('CD01')
  await rpc(RES, 'correct_usage', { p_transaction_id: usageId, p_quantity: 7, p_quantity_unit: 'mL', p_reason: 'Misread the syringe' })
  const after = await bottle('CD01')
  assert(num(after.current_quantity) === num(before.current_quantity) - 2 && num(after.total_used) === num(before.total_used) + 2, 'balance reconciled')
  const orig = (await db.query(`select quantity_change from public.transactions where id = $1`, [usageId])).rows[0]
  assert(num(orig.quantity_change) === -5, 'original transaction unchanged')
  const corr = (await db.query(`select * from public.transaction_corrections where original_transaction_id = $1`, [usageId])).rows
  assert(corr.length === 1 && num(corr[0].old_quantity) === 5 && num(corr[0].new_quantity) === 7 && corr[0].corrected_by === RES && corr[0].reason === 'Misread the syringe', 'audit row')
  const adj = (await db.query(`select * from public.transactions where corrects_transaction_id = $1`, [usageId])).rows
  assert(adj.length === 1 && adj[0].transaction_type === 'ADJUSTMENT' && num(adj[0].quantity_change) === -2, 'adjustment transaction')
  const h = await one(ADMIN, `select quantity, recorded_quantity, correction_count from public.usage_history where id = $1`, [usageId])
  assert(num(h.quantity) === 7 && num(h.recorded_quantity) === 5 && h.correction_count === 1, 'history shows corrected and original')
})
await check('8. A second correction is based on the corrected value (7 -> 4 mL)', async () => {
  const before = await bottle('CD01')
  await rpc(ADMIN, 'correct_usage', { p_transaction_id: usageId, p_quantity: 4, p_quantity_unit: 'mL', p_reason: 'Checked lab notebook' })
  assert(num((await bottle('CD01')).current_quantity) === num(before.current_quantity) + 3, 'returned 3 mL')
  const corr = (await db.query(`select old_quantity, new_quantity from public.transaction_corrections where original_transaction_id = $1 order by created_at`, [usageId])).rows
  assert(corr.length === 2 && num(corr[1].old_quantity) === 7 && num(corr[1].new_quantity) === 4, 'chain of corrections')
})
await check('8. Correction that would make stock negative is rejected and changes nothing', async () => {
  const before = await bottle('CD01')
  await rejects(rpc(ADMIN, 'correct_usage', { p_transaction_id: usageId, p_quantity: 500, p_quantity_unit: 'mL', p_reason: 'test' }), /INSUFFICIENT_QUANTITY/)
  assert(num((await bottle('CD01')).current_quantity) === num(before.current_quantity), 'unchanged')
})
await check('8. Correction needs a reason; a researcher cannot correct someone else\'s entry or after 24 h', async () => {
  await rejects(rpc(RES, 'correct_usage', { p_transaction_id: usageId, p_quantity: 3, p_quantity_unit: 'mL', p_reason: '' }), /REASON_REQUIRED/)
  await rejects(rpc(RES2, 'correct_usage', { p_transaction_id: usageId, p_quantity: 3, p_quantity_unit: 'mL', p_reason: 'not mine' }), /NOT_YOUR_ENTRY/)
  await db.query(`update public.transactions set created_at = now() - interval '25 hours' where id = $1`, [usageId])
  await rejects(rpc(RES, 'correct_usage', { p_transaction_id: usageId, p_quantity: 3, p_quantity_unit: 'mL', p_reason: 'late' }), /CORRECTION_WINDOW_CLOSED/)
  await rpc(ADMIN, 'correct_usage', { p_transaction_id: usageId, p_quantity: 4, p_quantity_unit: 'mL', p_reason: 'Purpose fix', p_purpose: 'NMR of compound 8' }) // Admin: any time
  const h = await one(ADMIN, `select purpose, quantity from public.usage_history where id = $1`, [usageId])
  assert(h.purpose === 'NMR of compound 8' && num(h.quantity) === 4, 'detail-only correction')
})
await check('8. Transactions and corrections cannot be edited or deleted through the API, even by the Admin', async () => {
  await rejects(as(ADMIN, () => db.query(`update public.transactions set quantity_change = 0 where id = $1`, [usageId])), /permission denied/)
  await rejects(as(ADMIN, () => db.query(`delete from public.transactions where id = $1`, [usageId])), /permission denied/)
  await rejects(as(ADMIN, () => db.query(`delete from public.transaction_corrections`)), /permission denied/)
})

// ---------------------------------------------------------------- 16, 17: permissions and atomicity
await check('16. Researcher cannot create, edit, count or import inventory', async () => {
  const b = await bottle('CD01')
  await rejects(rpc(RES, 'create_inventory_item', { p: { category: 'NMR_SOLVENT', chemical_name: 'X', bottle_id: 'X1', unit: 'mL', quantity: '1' } }), /ADMIN_ONLY/)
  await rejects(rpc(RES, 'update_inventory_item', { p_bottle_id: b.id, p_changes: { manufacturer: 'x' } }), /ADMIN_ONLY/)
  await rejects(rpc(RES, 'set_verified_quantity', { p_bottle_id: b.id, p_quantity: 100, p_quantity_unit: 'mL', p_reason: 'xxx' }), /ADMIN_ONLY/)
  await rejects(rpc(RES, 'import_solvent_batch', { p_idempotency_key: crypto.randomUUID(), p_file_name: 'x.xlsx', p_file_sha256: 'a'.repeat(64), p_rows: [{}], p_dry_run: true }), /ONLY_DESIGNATED_ADMIN/)
  const updated = await as(RES, () => db.query(`update public.bottles set manufacturer = 'hack' where id = $1`, [b.id]))
  assert(updated.affectedRows === 0, 'RLS blocks direct update')
})
await check('16. Even the Admin cannot overwrite a remaining quantity or insert a bottle directly', async () => {
  const b = await bottle('CD01')
  await rejects(as(ADMIN, () => db.query(`update public.bottles set current_quantity = 100 where id = $1`, [b.id])), /QUANTITY_IS_CALCULATED/)
  await rejects(as(ADMIN, () => db.query(`insert into public.bottles (bottle_id, chemical_id, current_quantity, quantity_unit) values ('Z9', $1, 5, 'mL')`, [b.chemical_id])), /USE_ADD_FUNCTION/)
  await as(ADMIN, () => db.query(`update public.bottles set notes = 'ok' where id = $1`, [b.id])) // descriptive fields still fine
})
await check('16. Suspended researcher cannot record usage or submit requests', async () => {
  await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [RES2])
  const b = await bottle('CD01')
  await rejects(rpc(RES2, 'record_usage', { p_bottle_id: b.id, p_quantity: 1, p_quantity_unit: 'mL' }), /ACCOUNT_NOT_ACTIVE/)
  await rejects(rpc(RES2, 'submit_order_request', { p: { chemical_name: 'X', requested_quantity: '1', quantity_unit: 'g' } }), /ACCOUNT_NOT_ACTIVE/)
})
await check('17. A failed operation leaves no partial writes (receive with duplicate Bottle ID)', async () => {
  const counts = async () => (await db.query(`select (select count(*) from public.bottles)::int b, (select count(*) from public.transactions)::int t, (select count(*) from public.chemicals)::int c`)).rows[0]
  const { id } = await rpc(RES, 'submit_order_request', { p: { chemical_name: 'Brand new reagent', requested_quantity: '10', quantity_unit: 'g' } })
  await rpc(ADMIN, 'update_order_request', { p_id: id, p_status: 'Approved' })
  const before = await counts()
  await rejects(rpc(ADMIN, 'receive_order', { p_request_id: id, p_item: { bottle_id: 'CD01', quantity: '10', unit: 'g' } }), /DUPLICATE_BOTTLE_ID/)
  const after = await counts()
  assert(JSON.stringify(before) === JSON.stringify(after), `partial writes: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
  assert((await db.query(`select status from public.chemical_order_requests where id = $1`, [id])).rows[0].status === 'Approved', 'status unchanged')
})

// ---------------------------------------------------------------- 12-14: orders
let orderId
await check('12. Researcher submits an order request; it is not stock', async () => {
  const before = (await db.query(`select count(*)::int n from public.bottles`)).rows[0].n
  const r = await rpc(RES, 'submit_order_request', { p: { chemical_name: 'DMSO-d6', category: 'NMR_SOLVENT', requested_quantity: '50', quantity_unit: 'mL', priority: 'High', reason: 'Running low', experiment: 'Project A' } })
  orderId = r.id
  assert((await db.query(`select count(*)::int n from public.bottles`)).rows[0].n === before, 'no bottle created')
  const h = (await db.query(`select to_status from public.order_request_history where request_id = $1`, [orderId])).rows
  assert(h.length === 1 && h[0].to_status === 'Requested', 'history started')
})
await check('12. Duplicate open request warns, and can be confirmed', async () => {
  await rejects(rpc(RES, 'submit_order_request', { p: { chemical_name: 'dmso-D6', requested_quantity: '25', quantity_unit: 'mL' } }), /DUPLICATE_OPEN_REQUEST/)
  const r = await rpc(RES, 'submit_order_request', { p: { chemical_name: 'dmso-D6', requested_quantity: '25', quantity_unit: 'mL' }, p_allow_duplicate: true })
  assert(r.duplicate_of === orderId, 'linked to the earlier request')
})
await check('12. Researchers see only their own requests; the Admin sees all', async () => {
  const mine = (await as(RES, () => db.query(`select requested_by from public.chemical_order_requests`))).rows
  assert(mine.length > 0 && mine.every(r => r.requested_by === RES), 'only own')
  await db.query(`update public.profiles set account_status = 'active' where id = $1`, [RES2])
  assert((await as(RES2, () => db.query(`select * from public.chemical_order_requests`))).rows.length === 0, 'other researcher sees none')
  assert((await as(ADMIN2, () => db.query(`select * from public.chemical_order_requests`))).rows.length >= 3, 'admin sees all')
})
await check('13. Researcher cannot approve; Admin approves, rejects (reason required) and invalid jumps are refused', async () => {
  await rejects(rpc(RES, 'update_order_request', { p_id: orderId, p_status: 'Approved' }), /ADMIN_ONLY/)
  await rejects(rpc(ADMIN, 'update_order_request', { p_id: orderId, p_status: 'Received' }), /INVALID_STATUS_CHANGE/)
  await rpc(ADMIN, 'update_order_request', { p_id: orderId, p_status: 'Approved', p_note: 'OK' })
  const { id: other } = await rpc(RES, 'submit_order_request', { p: { chemical_name: 'Gold chloride', requested_quantity: '1', quantity_unit: 'g' } })
  await rejects(rpc(ADMIN, 'update_order_request', { p_id: other, p_status: 'Rejected' }), /REASON_REQUIRED/)
  await rpc(ADMIN, 'update_order_request', { p_id: other, p_status: 'Rejected', p_note: 'Too expensive' })
  await rejects(rpc(RES, 'update_order_request', { p_id: other, p_status: 'Cancelled' }), /REQUEST_CLOSED/)
  const r = (await db.query(`select status, decision_note from public.chemical_order_requests where id = $1`, [other])).rows[0]
  assert(r.status === 'Rejected' && r.decision_note === 'Too expensive', 'rejected with reason')
})
await check('13. Admin marks as ordered with supplier details; researcher can no longer edit', async () => {
  await rpc(ADMIN, 'update_order_request', { p_id: orderId, p_status: 'Ordered', p_changes: { supplier: 'Sigma-Aldrich', purchase_order_number: 'PO-77', expected_delivery: '2026-11-15' } })
  const r = (await db.query(`select status, supplier, order_date, expected_delivery from public.chemical_order_requests where id = $1`, [orderId])).rows[0]
  assert(r.status === 'Ordered' && r.supplier === 'Sigma-Aldrich' && r.order_date, 'ordered')
  await rejects(rpc(RES, 'update_order_request', { p_id: orderId, p_changes: { notes: 'x' } }), /REQUEST_LOCKED/)
  const h = (await db.query(`select from_status, to_status from public.order_request_history where request_id = $1 order by created_at`, [orderId])).rows
  assert(h.map(x => `${x.from_status}>${x.to_status}`).join(',') === 'null>Requested,Requested>Approved,Approved>Ordered', `history ${JSON.stringify(h)}`)
})
await check('14. Receiving creates a bottle + STOCK_IN; partial then complete', async () => {
  const r1 = await rpc(ADMIN, 'receive_order', { p_request_id: orderId, p_item: { bottle_id: 'DM02', quantity: '25', unit: 'mL', bottle_size: '25', place: 'Z1', manufacturer: 'Sigma-Aldrich', batch_lot_number: 'L123', purchase_date: '2026-11-10', expiry_date: '2028-11-10' } })
  assert(r1.status === 'Partially Received', `status ${r1.status}`)
  const b = await bottle('DM02')
  assert(b.inventory_category === 'NMR_SOLVENT' && num(b.current_quantity) === 25 && b.batch_lot_number === 'L123', 'bottle created from the order')
  const tx = (await db.query(`select transaction_type, quantity_change, reference_number from public.transactions where bottle_id = $1`, [b.id])).rows
  assert(tx.length === 1 && tx[0].transaction_type === 'STOCK_IN' && tx[0].reference_number === orderId, 'stock-in linked to the order')
  const r2 = await rpc(ADMIN, 'receive_order', { p_request_id: orderId, p_item: { bottle_id: 'DM03', quantity: '25', unit: 'mL', bottle_size: '25', place: 'Z1' } })
  assert(r2.status === 'Received', 'complete')
  assert((await bottle('DM03')).chemical_id === b.chemical_id, 'second bottle on the same chemical record')
  await rejects(rpc(ADMIN, 'receive_order', { p_request_id: orderId, p_item: { bottle_id: 'DM04', quantity: '1', unit: 'mL' } }), /NOT_ORDERED_YET/)
})
await check('14. Receiving an existing chemical associates with its master record (CAS match)', async () => {
  const { id } = await rpc(RES, 'submit_order_request', { p: { chemical_name: 'Acetone AR', cas_number: '67-64-1', requested_quantity: '500', quantity_unit: 'mL' } })
  await rpc(ADMIN, 'update_order_request', { p_id: id, p_status: 'Approved' })
  await rpc(ADMIN, 'receive_order', { p_request_id: id, p_item: { bottle_id: 'ACE-2', quantity: '500', unit: 'mL' } })
  assert((await bottle('ACE-2')).chemical_id === '11111111-1111-1111-1111-111111111111', 'same chemical as LEG-1')
})

// ---------------------------------------------------------------- 15: import
const sheetRows = [
  { row: 3, part: null, category: 'COMMERCIAL_SOLVENT', name: 'Ethyl acetate', bottle_id: 'CS-ETHYLACETATE-01', generated_id: true, pack_size: '25', pack_unit: 'lit', make: 'Sannidhhi', place: 'Solvent room', raw: { pack_size: '25 lit' } },
  { row: 4, part: 1, category: 'NMR_SOLVENT', name: 'CDCl3 import', bottle_id: 'CDX1', pack_size: '100', pack_unit: 'ml', quantity: '80', quantity_unit: 'ml', place: 'Z1', raw: {} },
  { row: 7, part: null, category: 'NMR_SOLVENT', name: 'CAN-d3', bottle_id: 'CN01', pack_size: '10', pack_unit: 'ml', quantity: '25', quantity_unit: 'ml', place: 'Z1', legacy_last_used_by: 'Ravi', raw: {} },
]
await check('15. Solvent import dry run flags issues and writes nothing', async () => {
  const before = (await db.query(`select count(*)::int n from public.bottles`)).rows[0].n
  const r = await rpc(ADMIN, 'import_solvent_batch', { p_idempotency_key: '33333333-3333-3333-3333-333333333333', p_file_name: 'lab inventory additional tabs.xlsx', p_file_sha256: 'b'.repeat(64), p_rows: sheetRows, p_dry_run: true })
  assert(r.new === 3 && r.errors === 0 && r.needs_review === 2, JSON.stringify(r))
  const can = r.rows.find(x => x.bottle_id === 'CN01')
  assert(can.warnings.some(w => /more than the 10 mL pack size/.test(w)) && can.quantity === null, 'CAN-d3 flagged')
  assert((await db.query(`select count(*)::int n from public.bottles`)).rows[0].n === before, 'nothing written')
})
await check('15. Import writes all rows; the same file again adds nothing (idempotent)', async () => {
  const r = await rpc(ADMIN, 'import_solvent_batch', { p_idempotency_key: '33333333-3333-3333-3333-333333333333', p_file_name: 'lab inventory additional tabs.xlsx', p_file_sha256: 'b'.repeat(64), p_rows: sheetRows, p_dry_run: false })
  assert(r.new === 3, JSON.stringify(r))
  const cn = await bottle('CN01')
  assert(cn.current_quantity === null && cn.legacy_last_used_by === 'Ravi' && cn.last_used_by === null, 'legacy last user kept separately, no fake history')
  assert((await bottle('CDX1')).quantity_unit === 'mL' && num((await bottle('CDX1')).current_quantity) === 80, 'units normalised')
  const again = await rpc(ADMIN, 'import_solvent_batch', { p_idempotency_key: '44444444-4444-4444-4444-444444444444', p_file_name: 'copy.xlsx', p_file_sha256: 'b'.repeat(64), p_rows: sheetRows, p_dry_run: false })
  assert(again.already_imported === true, 'same file hash')
  const third = await rpc(ADMIN, 'import_solvent_batch', { p_idempotency_key: '55555555-5555-5555-5555-555555555555', p_file_name: 'edited.xlsx', p_file_sha256: 'c'.repeat(64), p_rows: sheetRows, p_dry_run: false })
  assert(third.new === 0 && third.existing === 3, 'existing bottle IDs are skipped')
})
await check('15. Import with an error saves nothing', async () => {
  const before = (await db.query(`select count(*)::int n from public.bottles`)).rows[0].n
  const bad = [{ row: 2, category: 'NMR_SOLVENT', name: 'D2O', bottle_id: 'DO01', pack_size: '25', pack_unit: 'ml', quantity: '20', quantity_unit: 'ml' },
               { row: 3, category: 'NMR_SOLVENT', name: 'D2O', bottle_id: 'DO01', pack_size: '25', pack_unit: 'ml' }]
  await rejects(rpc(ADMIN, 'import_solvent_batch', { p_idempotency_key: crypto.randomUUID(), p_file_name: 'bad.xlsx', p_file_sha256: 'd'.repeat(64), p_rows: bad, p_dry_run: false }), /IMPORT_HAS_ERRORS/)
  assert((await db.query(`select count(*)::int n from public.bottles`)).rows[0].n === before, 'nothing written')
})

// ---------------------------------------------------------------- 18: history after account removal
await check('18. Deactivating a researcher keeps their usage history and corrections', async () => {
  await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [RES])
  const h = (await as(ADMIN, () => db.query(`select user_name from public.usage_history where user_id = $1`, [RES]))).rows
  assert(h.length >= 3 && h.every(r => r.user_name === 'Ravi Researcher'), 'history and names kept')
  await rejects(db.query(`delete from auth.users where id = $1`, [RES]), /foreign key/)
  await db.query(`update public.profiles set account_status = 'active' where id = $1`, [RES])
})

await check('Legacy chemical bottles: backfilled untracked usage, record_usage still works', async () => {
  const b = await bottle('LEG-1')
  assert(b.inventory_category === 'CHEMICAL' && num(b.untracked_quantity) === 10, `untracked ${b.untracked_quantity}`)
  await rpc(RES, 'record_usage', { p_bottle_id: b.id, p_quantity: 1000, p_quantity_unit: 'mg' })
  assert(num((await bottle('LEG-1')).current_quantity) === 14, 'mg converted to g')
})

done()
