'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Booking, TripGroup } from '@/lib/studio/types'
import { groupBookingsIntoTrips } from '@/lib/studio/trip-grouping'
import { TripCard } from '@/components/studio/trips/TripCard'
import { BookingDetailPanel } from '@/components/studio/trips/BookingDetailPanel'

type Tab = 'active' | 'upcoming' | 'past'

export default function TripsPage() {
  const [tab, setTab]               = useState<Tab>('active')
  const [bookings, setBookings]     = useState<Booking[]>([])
  const [trips, setTrips]           = useState<TripGroup[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [userEmail, setUserEmail]   = useState('')
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null)

  const load = useCallback(async (t: Tab) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/studio/trips?tab=${t}`)
      if (!res.ok) throw new Error(`Failed to load trips (${res.status})`)
      const { bookings: data, userEmail: email } = await res.json()
      setBookings(data)
      setTrips(groupBookingsIntoTrips(data))
      setUserEmail(email)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(tab) }, [tab, load])

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'active',   label: 'Active' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'past',     label: 'Past' },
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-[#E5E4E0] px-5 bg-white shrink-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={[
              'text-[12px] px-1 py-3 mr-5 border-b-2 transition-colors',
              tab === t.key
                ? 'border-[#0F0F0D] text-[#0F0F0D] font-medium'
                : 'border-transparent text-[#6B6A67] hover:text-[#0F0F0D]',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">
        {loading && (
          <div className="text-[13px] text-[#9B9A97] py-10 text-center">Loading trips…</div>
        )}
        {error && (
          <div className="text-[13px] text-[#E24B4A] py-10 text-center">{error}</div>
        )}
        {!loading && !error && trips.length === 0 && (
          <div className="text-[13px] text-[#9B9A97] py-10 text-center">
            No {tab} trips.
          </div>
        )}
        {!loading && !error && trips.map(trip => (
          <TripCard
            key={trip.key}
            trip={trip}
            onLegClick={setSelectedBooking}
          />
        ))}
      </div>

      {/* Booking detail panel */}
      {selectedBooking && (
        <BookingDetailPanel
          booking={selectedBooking}
          allBookings={bookings}
          userEmail={userEmail}
          onClose={() => setSelectedBooking(null)}
          onSuperseded={() => load(tab)}
        />
      )}
    </div>
  )
}
