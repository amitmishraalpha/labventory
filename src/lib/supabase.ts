import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabaseConfigured = Boolean(url && anonKey)
export const supabase = createClient(url ?? 'https://placeholder.supabase.co', anonKey ?? 'placeholder-anon-key')

export async function getSupabaseErrorMessage(error: unknown, fallback: string) {
	if (error && typeof error === 'object' && 'context' in error) {
		const context = (error as { context?: unknown }).context
		if (context instanceof Response) {
			const body = await context.clone().json().catch(() => null) as { error?: unknown; message?: unknown } | null
			if (typeof body?.error === 'string') return body.error
			if (typeof body?.message === 'string') return body.message
		}
	}
	if (error instanceof Error && error.message) return error.message
	// PostgREST errors from supabase.from()/rpc() are plain { message, code, details, hint } objects.
	if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' && (error as { message: string }).message) return (error as { message: string }).message
	return fallback
}
