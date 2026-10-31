// Starts the isolated stack for browser tests: PGlite (replica schema + migration) -> mock Supabase -> Vite dev.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupDb, ROOT } from '../db/harness.mjs'
import { startMock } from './mock-supabase.mjs'

export const MIGRATION = 'supabase/migrations/20261031090000_solvents_corrections_orders.sql'

export async function startApp({ mockPort = 54329, vitePort = 5199, beforeMigrations } = {}) {
  const dbh = await setupDb({ migrations: [MIGRATION], beforeMigrations })
  const mock = await startMock({ db: dbh.db, as: dbh.as, port: mockPort })
  const envDir = mkdtempSync(join(tmpdir(), 'labventory-env-'))
  const vite = spawn(process.execPath, [`${ROOT}node_modules/vite/bin/vite.js`, '--config', `${ROOT}tests/ui/vite.test.config.mjs`], {
    cwd: ROOT, env: { ...process.env, LABVENTORY_TEST_ENVDIR: envDir, LABVENTORY_TEST_PORT: String(vitePort), VITE_SUPABASE_URL: `http://127.0.0.1:${mockPort}`, VITE_SUPABASE_ANON_KEY: 'test-anon-key' },
  })
  vite.stderr.on('data', d => process.stderr.write(d))
  const base = `http://127.0.0.1:${vitePort}`
  // Wait until the dev server answers.
  for (let i = 0; ; i++) {
    try { const res = await fetch(base); if (res.ok) break } catch { /* not up yet */ }
    if (i > 120) throw new Error('vite did not start')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const stop = async () => { vite.kill(); mock.server.close() }
  return { ...dbh, ...mock, base, stop }
}
