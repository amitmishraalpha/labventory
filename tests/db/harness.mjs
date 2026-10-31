// Isolated test database: PGlite (in-process Postgres) loaded with a schema-only replica of the
// live database (tests/db/live-schema.sql) plus any migrations under test. Never touches Supabase.
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = path => readFileSync(`${ROOT}${path}`, 'utf8')

export async function setupDb({ migrations = [], beforeMigrations } = {}) {
  const db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(`create extension pg_trgm;
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role; grant usage on schema public to anon, authenticated, service_role;
    create publication supabase_realtime;`)
  await db.exec(read('tests/db/live-schema.sql'))

  const ADMIN = randomUUID(), ADMIN2 = randomUUID(), RES = randomUUID(), RES2 = randomUUID()
  await db.exec(`insert into auth.users (id, email) values ('${ADMIN}','admin@lab.test'),('${ADMIN2}','admin2@lab.test'),('${RES}','res@lab.test'),('${RES2}','res2@lab.test');
    insert into public.profiles (id, full_name, role, email, account_status) values
      ('${ADMIN}','Priya Admin','ADMIN','admin@lab.test','active'),('${ADMIN2}','Second Admin','ADMIN','admin2@lab.test','active'),
      ('${RES}','Ravi Researcher','RESEARCHER','res@lab.test','active'),('${RES2}','Rita Researcher','RESEARCHER','res2@lab.test','active');
    insert into public.system_settings values ('designated_admin', '{"user_id":"${ADMIN}"}');`)
  // Rows that exist in production before the migrations under test run (e.g. to test backfills).
  if (beforeMigrations) await db.exec(beforeMigrations({ ADMIN, ADMIN2, RES, RES2 }))
  for (const migration of migrations) await db.exec(read(migration))

  // PGlite is a single connection, so role switches must never interleave.
  let chain = Promise.resolve()
  const as = (user, fn) => {
    const run = chain.then(async () => {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ?? ''}', false); set role ${user ? 'authenticated' : 'anon'};`)
      try { return await fn() } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`) }
    })
    chain = run.catch(() => {})
    return run
  }
  return { db, ADMIN, ADMIN2, RES, RES2, as }
}

// Minimal test runner: named checks, a summary, non-zero exit on failure.
export function runner(title) {
  let passed = 0, failed = 0
  const check = async (name, fn) => {
    try { await fn(); passed++; console.log(`PASS  ${name}`) } catch (error) { failed++; console.log(`FAIL  ${name}\n      ${error?.message ?? error}`) }
  }
  const done = () => { console.log(`\n${title}: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1 }
  return { check, done }
}
export const assert = (condition, message) => { if (!condition) throw new Error(message) }
export async function rejects(promise, pattern) {
  try { await promise } catch (error) { if (pattern && !pattern.test(error.message)) throw new Error(`wrong error: ${error.message}`); return }
  throw new Error(`expected an error matching ${pattern}`)
}
