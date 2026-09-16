import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

function jwtRole(key) {
  try {
    const payload = key?.split('.')[1]?.replaceAll('-', '+').replaceAll('_', '/')
    return payload ? JSON.parse(globalThis.atob(payload)).role : null
  } catch { return null }
}

const isSecretKey = supabaseAnonKey?.startsWith('sb_secret_') || jwtRole(supabaseAnonKey) === 'service_role'
const isPublicKey = supabaseAnonKey?.startsWith('sb_publishable_') || supabaseAnonKey?.startsWith('eyJ')

const configured = Boolean(
  supabaseUrl?.startsWith('https://') &&
  supabaseAnonKey &&
  isPublicKey &&
  !isSecretKey &&
  !supabaseUrl.includes('your_supabase') &&
  !supabaseAnonKey.includes('your_supabase'),
)

export const supabaseConfigError = configured ? null : isSecretKey
  ? 'The frontend contains a secret Supabase key. Replace it with the project publishable/anon key, rotate the exposed secret key, then restart Vite.'
  : 'Supabase is not configured. Copy frontend/.env.example to frontend/.env, add the project URL and publishable/anon key, then restart Vite.'

export const supabase = configured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      realtime: { params: { eventsPerSecond: 8 } },
    })
  : null
