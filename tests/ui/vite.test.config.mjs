// Isolated dev server for the browser tests: its own port and cache, and an empty envDir so the real
// .env.local (production Supabase) is never loaded. The mock Supabase URL/key come from process env.
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
export default {
  root,
  envDir: process.env.LABVENTORY_TEST_ENVDIR,
  cacheDir: `${root}node_modules/.vite-ui-test`,
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.LABVENTORY_TEST_PORT ?? 5199), strictPort: true },
  logLevel: 'error',
}
