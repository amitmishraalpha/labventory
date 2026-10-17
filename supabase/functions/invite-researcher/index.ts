import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('Authorization')
  if (!authorization) return json({ error: 'Authentication required' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const rawSecretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (!supabaseUrl || !rawSecretKeys) return json({ error: 'Invitation service is missing its Supabase server configuration' }, 500)
  let serviceRoleKey: string | undefined
  try {
    serviceRoleKey = JSON.parse(rawSecretKeys).default
  } catch {
    return json({ error: 'Invitation service has invalid SUPABASE_SECRET_KEYS configuration' }, 500)
  }
  if (!serviceRoleKey) return json({ error: 'Invitation service has no default Supabase secret key configured' }, 500)
  const admin = createClient(supabaseUrl, serviceRoleKey)
  const accessToken = authorization.replace(/^Bearer\s+/i, '')
  const { data: { user: caller }, error: callerError } = await admin.auth.getUser(accessToken)
  if (callerError || !caller) return json({ error: 'Authentication required' }, 401)

  const { data: callerProfile } = await admin.from('profiles').select('role,account_status').eq('id', caller.id).single()
  if (callerProfile?.role !== 'ADMIN' || callerProfile.account_status !== 'active') return json({ error: 'Only the active Admin can invite researchers' }, 403)

  const body = await request.json().catch(() => ({})) as { email?: string; full_name?: string | null }
  const email = body.email?.trim().toLowerCase() ?? ''
  const fullName = body.full_name?.trim() || 'Pending researcher'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address' }, 400)
  if (email === caller.email?.toLowerCase()) return json({ error: 'The designated Admin cannot be invited as a researcher' }, 400)

  const { data: existingProfiles } = await admin.from('profiles').select('id,email,account_status').ilike('email', email).limit(1)
  if (existingProfiles?.length) return json({ error: 'This email already has an application account' }, 409)
  const { data: usersPage } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (usersPage?.users.some(user => user.email?.toLowerCase() === email)) return json({ error: 'This email already has an Auth account' }, 409)

  const { data: invitation, error: invitationError } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName, role: 'RESEARCHER' } })
  if (invitationError || !invitation.user) return json({ error: invitationError?.message ?? 'Invitation could not be sent' }, 400)
  const { error: profileError } = await admin.from('profiles').insert({ id: invitation.user.id, email, full_name: fullName, role: 'RESEARCHER', account_status: 'invited', invited_by: caller.id, invited_at: new Date().toISOString() })
  if (profileError) { await admin.auth.admin.deleteUser(invitation.user.id); return json({ error: 'Invitation was not saved. Please try again.' }, 500) }
  await admin.from('activity_log').insert({ actor_user_id: caller.id, target_user_id: invitation.user.id, action_type: 'INVITATION_SENT', metadata: { email } })
  return json({ invited: true, user_id: invitation.user.id })
})
