'use client'

import { useState, useCallback, useEffect } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { TripBuilderChat } from './TripBuilderChat'
import { TripSidebar } from './TripSidebar'

const LAST_TRIP_KEY = 'tripBuilder:lastTripId'

// Owns tripId as the single source of truth (synced to the URL) and a
// refreshKey that increments on any activity reported by the chat pane —
// this is how the sidebar updates live as the chat progresses without the
// chat needing to know the sidebar exists.
export function TripBuilderWorkspace() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // Initial state must match the server-rendered value (URL only) to avoid
  // a hydration mismatch — localStorage is only consulted client-side,
  // after mount, in the effect below.
  const [tripId, setTripId] = useState<string | null>(searchParams.get('trip'))
  const [refreshKey, setRefreshKey] = useState(0)

  // Restore the last-open trip after navigating away and back — the Studio
  // sidebar's nav links (Queue, Bookings, etc.) don't carry ?trip= with
  // them, so without this, leaving and returning to Trip Builder used to
  // silently drop back to "no trip open" even though the chat history is
  // still fully persisted server-side.
  useEffect(() => {
    if (tripId) return
    const stored = localStorage.getItem(LAST_TRIP_KEY)
    if (stored) {
      setTripId(stored)
      router.replace(`${pathname}?trip=${stored}`, { scroll: false })
    }
    // Mount-only restore — later changes go through handleTripIdChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (tripId) localStorage.setItem(LAST_TRIP_KEY, tripId)
    else localStorage.removeItem(LAST_TRIP_KEY)
  }, [tripId])

  const handleTripIdChange = useCallback((newTripId: string | null) => {
    setTripId(newTripId)
    router.replace(newTripId ? `${pathname}?trip=${newTripId}` : pathname, { scroll: false })
    setRefreshKey(k => k + 1)
  }, [pathname, router])

  const handleActivity = useCallback(() => {
    setRefreshKey(k => k + 1)
  }, [])

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0">
        <TripBuilderChat tripId={tripId} onTripIdChange={handleTripIdChange} onActivity={handleActivity} />
      </div>
      <aside className="w-[320px] border-l border-[#E5E4E0] shrink-0">
        <TripSidebar tripId={tripId} refreshKey={refreshKey} />
      </aside>
    </div>
  )
}
