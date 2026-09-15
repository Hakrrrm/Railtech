import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'

export function useSupabaseData(loader, dependencies = [], subscriptions = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null, updatedAt: null })
  const timer = useRef(null)

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setState((current) => ({ ...current, loading: true, error: null }))
    try {
      const data = await loader()
      setState({ data, loading: false, error: null, updatedAt: new Date() })
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }))
    }
  // Loader arguments are represented by dependencies supplied by each page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies)

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!supabase || subscriptions.length === 0) return undefined
    const channel = supabase.channel(`dashboard-${Math.random().toString(36).slice(2)}`)
    subscriptions.forEach(({ table, event = '*', filter }) => {
      channel.on('postgres_changes', {
        event, schema: 'public', table, ...(filter ? { filter } : {}),
      }, () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => refresh(true), 180)
      })
    })
    channel.subscribe()
    return () => {
      clearTimeout(timer.current)
      supabase.removeChannel(channel)
    }
  }, [refresh, subscriptions])

  return { ...state, refresh }
}
