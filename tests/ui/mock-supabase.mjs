// Minimal Supabase stand-in (Auth + the PostgREST calls the app makes) backed by the PGlite test database.
// Every query runs under the caller's role and JWT subject, so RLS policies and function checks are exercised.
import http from 'node:http'

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
export const makeToken = user => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const subOf = token => { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub } catch { return null } }
const ident = name => { if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`); return name }

// Embedded resources the app requests (PostgREST "table(columns)" syntax), keyed by table.
const sources = {
  bottles: `select b.*,
    (select to_jsonb(c) from public.chemicals c where c.id = b.chemical_id) chemicals,
    (select to_jsonb(s) from public.suppliers s where s.id = b.supplier_id) suppliers,
    (select to_jsonb(l) from public.locations l where l.id = b.location_id) locations
    from public.bottles b`,
}

export function startMock({ db, as, port, log = () => {} }) {
  const stats = { rpc: {}, requests: 0 }
  const server = http.createServer(async (req, res) => {
    stats.requests++
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Expose-Headers': '*' }
    const send = (status, body) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)) }
    if (req.method === 'OPTIONS') return send(204)
    const url = new URL(req.url, 'http://x'); const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || 'null') : null
    const userId = subOf((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
    log(req.method, url.pathname + url.search)
    try {
      // ---- Auth
      if (url.pathname === '/auth/v1/token') {
        let user
        if (url.searchParams.get('grant_type') === 'password') {
          user = (await db.query('select id, email from auth.users where lower(email) = lower($1)', [body.email])).rows[0]
          if (!user || body.password !== 'test-password') return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' })
        } else {
          user = (await db.query('select id, email from auth.users where id::text = $1', [String(body.refresh_token).slice(2)])).rows[0]
          if (!user) return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
        }
        return send(200, { access_token: makeToken(user), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `r-${user.id}`, user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } })
      }
      if (url.pathname === '/auth/v1/user') {
        const user = userId && (await db.query('select id, email from auth.users where id = $1', [userId])).rows[0]
        return user ? send(200, { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: {}, user_metadata: {} }) : send(401, { msg: 'invalid JWT' })
      }
      if (url.pathname === '/auth/v1/logout') return send(204)

      // ---- PostgREST: RPC
      const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/)
      if (rpc && req.method === 'POST') {
        const fn = ident(rpc[1]); const keys = Object.keys(body ?? {}).map(ident)
        stats.rpc[fn] = (stats.rpc[fn] ?? 0) + 1
        const values = keys.map(key => (body[key] !== null && typeof body[key] === 'object' ? JSON.stringify(body[key]) : body[key]))
        const result = await as(userId, () => db.query(`select public.${fn}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')}) as r`, values))
        return send(200, result.rows[0].r ?? null)
      }
      // ---- PostgREST: reads with eq / gte / lte / in filters, order, offset/limit
      const table = url.pathname.match(/^\/rest\/v1\/(\w+)$/)?.[1]
      if (table && req.method === 'GET') {
        const exists = (await db.query(`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = $1`, [table])).rows.length
        if (!exists) return send(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` })
        const where = []; const params = []
        for (const [key, value] of url.searchParams) {
          if (['select', 'order', 'offset', 'limit'].includes(key)) continue
          const [op, ...rest] = value.split('.'); const operand = rest.join('.')
          const column = `t.${ident(key)}`
          if (op === 'eq') { params.push(operand); where.push(`${column}::text = $${params.length}`) }
          else if (op === 'gte' || op === 'lte') { params.push(operand); where.push(`${column} ${op === 'gte' ? '>=' : '<='} $${params.length}`) }
          else if (op === 'in') { const list = operand.replace(/^\(|\)$/g, '').split(',').map(item => item.replace(/^"|"$/g, '')); params.push(list); where.push(`${column}::text = any($${params.length}::text[])`) }
          else if (op === 'is') where.push(`${column} is ${operand === 'null' ? 'null' : 'not null'}`)
          else throw new Error(`mock: unsupported filter ${op}`)
        }
        const order = (url.searchParams.get('order') ?? '').split(',').filter(Boolean).map(part => { const [col, dir] = part.split('.'); return `t.${ident(col)} ${dir === 'desc' ? 'desc' : 'asc'}` })
        const offset = Number(url.searchParams.get('offset') ?? 0); const limit = url.searchParams.get('limit')
        const sql = `select coalesce(jsonb_agg(to_jsonb(t)${order.length ? ` order by ${order.join(', ')}` : ''}), '[]'::jsonb) r from (select * from (${sources[table] ?? `select * from public.${table}`}) t ${where.length ? `where ${where.join(' and ')}` : ''} ${order.length ? `order by ${order.join(', ')}` : ''} offset ${offset} ${limit ? `limit ${Number(limit)}` : ''}) t`
        return send(200, (await as(userId, () => db.query(sql, params))).rows[0].r)
      }
      if (table === 'profiles' && req.method === 'PATCH') {
        const where = [...url.searchParams].filter(([key]) => key !== 'select').map(([key, value]) => [ident(key), value.replace(/^eq\./, '')])
        const sets = Object.keys(body).map(ident); const params = [...sets.map(key => body[key]), ...where.map(([, value]) => value)]
        const sql = `update public.profiles set ${sets.map((key, i) => `${key} = $${i + 1}`).join(', ')} where ${where.map(([key], i) => `${key}::text = $${sets.length + i + 1}`).join(' and ')} returning id`
        return send(200, (await as(userId, () => db.query(sql, params))).rows)
      }
      if (table === 'activity_log' && req.method === 'POST') {
        const keys = Object.keys(body).map(ident)
        await as(userId, () => db.query(`insert into public.activity_log (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map(key => (typeof body[key] === 'object' ? JSON.stringify(body[key]) : body[key]))))
        return send(201)
      }
      return send(404, { message: `mock: unsupported ${req.method} ${url.pathname}` })
    } catch (error) {
      log('  ->', error.code, error.message)
      return send(error.code === '42501' ? 403 : 400, { code: error.code ?? 'P0001', message: error.message, details: null, hint: null })
    }
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, stats })))
}
