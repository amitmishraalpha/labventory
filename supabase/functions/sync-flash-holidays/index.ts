import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { parsePublicHolidays } from './ics.ts'

// Admin-only: reads Google Calendar's public Indian holidays feed (no API key needed for the
// public calendar) and stores the public holidays in flash_holidays via replace_google_holidays.
const CALENDAR_ID = 'en.indian#holiday@group.v.calendar.google.com'
const FEED = `https://calendar.google.com/calendar/ical/${encodeURIComponent(CALENDAR_ID)}/public/basic.ics`

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('Authorization')
  if (!authorization) return json({ error: 'Authentication required' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const rawSecretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (!supabaseUrl || !rawSecretKeys) return json({ error: 'Holiday sync is missing its Supabase server configuration' }, 500)
  let serviceRoleKey: string | undefined
  try { serviceRoleKey = JSON.parse(rawSecretKeys).default } catch { return json({ error: 'Holiday sync has invalid SUPABASE_SECRET_KEYS configuration' }, 500) }
  if (!serviceRoleKey) return json({ error: 'Holiday sync has no default Supabase secret key configured' }, 500)
  const admin = createClient(supabaseUrl, serviceRoleKey)

  const { data: { user: caller }, error: callerError } = await admin.auth.getUser(authorization.replace(/^Bearer\s+/i, ''))
  if (callerError || !caller) return json({ error: 'Authentication required' }, 401)
  const { data: profile } = await admin.from('profiles').select('role,account_status').eq('id', caller.id).single()
  if (profile?.role !== 'ADMIN' || profile.account_status !== 'active') return json({ error: 'Only the active Admin can sync holidays' }, 403)

  const feed = await fetch(FEED)
  if (!feed.ok) return json({ error: `Google Calendar returned ${feed.status}` }, 502)
  const holidays = parsePublicHolidays(await feed.text())
  if (!holidays.length) return json({ error: 'No public holidays found in the Google Calendar feed; nothing was changed' }, 502)

  // Keep past holidays as they were; refresh from 30 days ago onwards.
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const { data: stored, error } = await admin.rpc('replace_google_holidays', { p_rows: holidays, p_from: from, p_actor: caller.id })
  if (error) return json({ error: error.message }, 500)
  return json({ synced: stored, from, source: CALENDAR_ID })
})
