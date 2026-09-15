import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

const configured = Boolean(
  supabaseUrl?.startsWith('https://') &&
  supabaseAnonKey &&
  !supabaseUrl.includes('your_supabase') &&
  !supabaseAnonKey.includes('your_supabase'),
)

export const supabaseConfigError = configured
  ? null
  : 'Supabase is not configured. Copy frontend/.env.example to frontend/.env, add the project URL and anon key, then restart Vite.'

export const supabase = configured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      realtime: { params: { eventsPerSecond: 8 } },
    })
  : null
