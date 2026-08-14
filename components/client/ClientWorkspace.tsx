'use client'

import { useState, useEffect, useCallback } from 'react'
import { DEMO_GUEST_PROFILE } from './placeholderData'
import { TripListSidebar } from './TripListSidebar'
import { ChatColumn } from './ChatColumn'
import { RightSidebar, type RightTab } from './RightSidebar'
import { GuestProfilePanel } from './GuestProfilePanel'

export interface TripSummary {
  id:         string
  title:      string | null
  updated_at: string
}

// Owns the trip list, which trip is active, both sidebars' collapse state,
// the guest profile panel, and a refreshKey that bumps on any chat
// activity — the same "onActivity -> refreshKey -> sidebar refetch"
// pattern Studio's Trip Builder already uses (TripBuilderWorkspace), so
// the itinerary/rates sidebar updates right after the Curator's reply
// lands rather than only on a manual reload. This is turn-by-turn, not
// token-level streaming — no streaming transport exists anywhere in this
// codebase yet (Trip Builder's chat is single-shot request/response too).
export function ClientWorkspace() {
  const [trips, setTrips] = useState<TripSummary[]>([])
  const [tripsLoading, setTripsLoading] = useState(true)
  const [tripsError, setTripsError] = useState<string | null>(null)
  const [activeTripId, setActiveTripId] = useState<string | null>(null)

  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [rightTab, setRightTab] = useState<RightTab>('itinerary')
  const [profileOpen, setProfileOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const loadTrips = useCallback((selectId?: string) => {
    setTripsLoading(true)
    setTripsError(null)
    fetch('/api/client/trips')
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to load trips')
        setTrips(data.trips)
        if (selectId) {
          setActiveTripId(selectId)
        } else {
          setActiveTripId(prev => prev ?? data.trips[0]?.id ?? null)
        }
      })
      .catch(err => setTripsError(err.message))
      .finally(() => setTripsLoading(false))
  }, [])

  useEffect(() => { loadTrips() }, [loadTrips])

  async function handleNewTrip() {
    setTripsError(null)
    try {
      const res = await fetch('/api/client/trips', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to start a new trip')
      loadTrips(data.id)
      setRightTab('itinerary')
    } catch (err: any) {
      setTripsError(err.message)
    }
  }

  const handleActivity = useCallback(() => {
    setRefreshKey(k => k + 1)
    // A chat turn can add a leg/dates, which changes this trip's derived
    // title — refresh the list (not just the active trip's sidebar) so
    // the left-hand entry relabels itself without a manual reload.
    loadTrips()
  }, [loadTrips])

  return (
    <div className="flex h-full min-h-0">
      <aside className={['border-r border-[#E5E4E0] shrink-0 transition-[width] duration-150', leftCollapsed ? 'w-[52px]' : 'w-[248px]'].join(' ')}>
        <TripListSidebar
          trips={trips}
          activeTripId={activeTripId}
          collapsed={leftCollapsed}
          guestName={DEMO_GUEST_PROFILE.name}
          onSelectTrip={setActiveTripId}
          onNewTrip={handleNewTrip}
          onToggleCollapse={() => setLeftCollapsed(v => !v)}
          onOpenProfile={() => setProfileOpen(true)}
        />
      </aside>

      <div className="flex-1 min-w-0">
        {tripsLoading ? (
          <div className="flex items-center justify-center h-full text-[12.5px] text-[#9B9A97]">Loading…</div>
        ) : tripsError ? (
          <div className="flex items-center justify-center h-full text-[12.5px] text-[#E24B4A] px-6 text-center">{tripsError}</div>
        ) : activeTripId ? (
          <ChatColumn key={activeTripId} tripId={activeTripId} tripTitle={trips.find(t => t.id === activeTripId)?.title ?? 'New trip'} onActivity={handleActivity} />
        ) : (
          <div className="flex items-center justify-center h-full text-[13px] text-[#9B9A97] px-6 text-center">
            Start a trip to begin planning.
          </div>
        )}
      </div>

      <aside className={['border-l border-[#E5E4E0] shrink-0 transition-[width] duration-150', rightCollapsed ? 'w-[44px]' : 'w-[340px]'].join(' ')}>
        {activeTripId ? (
          <RightSidebar
            key={activeTripId}
            tripId={activeTripId}
            collapsed={rightCollapsed}
            tab={rightTab}
            refreshKey={refreshKey}
            onToggleCollapse={() => setRightCollapsed(v => !v)}
            onTabChange={setRightTab}
            onActivity={handleActivity}
          />
        ) : (
          !rightCollapsed && <div className="flex items-center justify-center h-full text-[12px] text-[#9B9A97] px-4 text-center">Nothing to show yet.</div>
        )}
      </aside>

      {profileOpen && <GuestProfilePanel onClose={() => setProfileOpen(false)} />}
    </div>
  )
}
