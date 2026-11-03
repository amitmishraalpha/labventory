// Database tests for 20261103090000_flash_evening_hours.sql, run against the isolated replica.
// node tests/db/flash-hours.test.mjs
import { setupDb, runner, assert, rejects } from './harness.mjs'

const MIGRATION = 'supabase/migrations/20261103090000_flash_evening_hours.sql'
// Bookings made under the old 09:00-18:00 schedule: one past, one upcoming (17:00-18:00 IST, a week out).
const existing = ({ RES }) => `insert into public.flash_bookings (id, booking_group, user_id, booked_by_name, slot_start, slot_end, purpose) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', '${RES}', 'Ravi Researcher', '2026-10-01 10:00+05:30', '2026-10-01 11:00+05:30', 'Old run'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', '${RES}', 'Ravi Researcher', ((now() at time zone 'Asia/Kolkata')::date + 7 + time '17:00') at time zone 'Asia/Kolkata', ((now() at time zone 'Asia/Kolkata')::date + 7 + time '18:00') at time zone 'Asia/Kolkata', 'Upcoming run');`
const { db, RES, RES2, as } = await setupDb({ migrations: [MIGRATION], beforeMigrations: existing })
const { check, done } = runner('flash evening hours')
const before = (await db.query(`select * from public.flash_bookings order by id`)).rows

const day = (await db.query(`select ((now() at time zone 'Asia/Kolkata')::date + 7)::text d`)).rows[0].d
const book = (user, hour, slots = 1, date = day) => as(user, () => db.query(`select public.book_flash_slots($1::date, $2, $3, 'test') as r`, [date, hour, slots])).then(r => r.rows[0].r)
// Lab-local (IST) start and end of a booking group, independent of the session time zone.
const span = async group => (await db.query(`select to_char(min(slot_start) at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') s, to_char(max(slot_end) at time zone 'Asia/Kolkata', 'HH24:MI') e, count(*)::int n from public.flash_bookings where booking_group = $1`, [group])).rows[0]

await check('config: 09:00-22:00 IST, other rules unchanged', async () => {
  const c = (await db.query(`select public.flash_config() c`)).rows[0].c
  assert(c.open_hour === 9 && c.close_hour === 22 && c.timezone === 'Asia/Kolkata' && c.max_slots === 3 && c.max_days_ahead === 60, JSON.stringify(c))
})
for (const hour of [9, 18, 19, 21]) {
  await check(`researcher books the ${hour}:00 slot (stored as ${hour}:00 IST)`, async () => {
    const r = await book(RES, hour)
    const s = await span(r.booking_group)
    assert(s.s === `${day} ${String(hour).padStart(2, '0')}:00` && s.e === `${hour + 1}:00` && s.n === 1, JSON.stringify(s))
  })
}
await check('a booking ending exactly at 22:00 is accepted (20:00, 2 hours)', async () => {
  await db.query(`delete from public.flash_bookings where slot_start >= ($1::date + time '20:00') at time zone 'Asia/Kolkata'`, [day])
  const s = await span((await book(RES2, 20, 2)).booking_group)
  assert(s.s.endsWith('20:00') && s.e === '22:00' && s.n === 2, JSON.stringify(s))
})
await check('a booking running past 22:00 is rejected (21:00, 2 hours)', () => rejects(book(RES, 21, 2, addDay(day)), /OUTSIDE_LAB_HOURS: slots can be booked between 09:00 and 22:00/))
await check('a booking starting at 22:00 is rejected', () => rejects(book(RES, 22, 1, addDay(day)), /OUTSIDE_LAB_HOURS/))
await check('a booking before 09:00 is rejected', () => rejects(book(RES, 8, 1, addDay(day)), /OUTSIDE_LAB_HOURS/))
await check('an 08:00 booking spilling into 09:00 is rejected', () => rejects(book(RES, 8, 2, addDay(day)), /OUTSIDE_LAB_HOURS/))
await check('double booking an evening slot is prevented', () => rejects(book(RES2, 19), /SLOT_TAKEN: the 19:00 slot is already booked by Ravi Researcher/))
await check('overlapping evening booking is prevented (18:00 for 2 hours overlaps 19:00)', async () => {
  await db.query(`delete from public.flash_bookings where slot_start = ($1::date + time '18:00') at time zone 'Asia/Kolkata'`, [day])
  await rejects(book(RES2, 18, 2), /SLOT_TAKEN: the 19:00 slot/)
})
await check('the unique slot index still blocks a direct duplicate insert', async () => {
  await rejects(db.query(`insert into public.flash_bookings (booking_group, user_id, booked_by_name, slot_start, slot_end) select gen_random_uuid(), user_id, booked_by_name, slot_start, slot_end from public.flash_bookings where slot_start = ($1::date + time '21:00') at time zone 'Asia/Kolkata' and cancelled_at is null`, [day]), /flash_bookings_one_per_slot/)
})
await check('max 3 consecutive slots still enforced in the evening', () => rejects(book(RES, 18, 4, addDay(day)), /INVALID_DURATION/))
await check('existing bookings are unchanged by the migration', async () => {
  const after = (await db.query(`select * from public.flash_bookings where id = any($1::uuid[]) order by id`, [before.map(b => b.id)])).rows
  assert(after.length === 2 && JSON.stringify(after) === JSON.stringify(before), 'existing rows changed')
})

function addDay(date) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }
done()
