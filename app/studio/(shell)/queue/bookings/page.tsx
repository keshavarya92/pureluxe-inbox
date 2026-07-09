'use client'

import { useState, useEffect, useCallback } from 'react'
import type { QueueBooking } from '@/lib/studio/types'
import { BookingQueueCard } from '@/components/studio/queue/BookingQueueCard'

type Filter = 'all' | 'mine' | 'missing' | 'duplicate'

export default function QueueBookingsPage() {
  const [bookings, setBookings]   = useState<QueueBooking[]>([])
  const [loading, setLoading]     = useState(true)
  const [filter, setFilter]       = useState<Filter>('all')
  const [userEmail, setUserEmail] = useState<string>('')
  const [error, setError]         = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/studio/queue/bookings')
      if (!res.ok) throw new Error(`Failed to load queue (${res.status})`)
      const { bookings: data, userEmail: email } = await res.json()
      setBookings(data)
      setUserEmail(email)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleAction(action: string, bookingId: string, tripId?: string) {
    const res = await fetch('/api/studio/queue/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, bookingId, tripId }),
    })
    if (!res.ok) {
      const { error } = await res.json()
      throw new Error(error ?? 'Action failed')
    }
  }

  const filtered = bookings.filter(b => {
    if (filter === 'mine')      return b.booked_by_name === userEmail
    if (filter === 'missing')   return b.missing_required.length > 0
    if (filter === 'duplicate') return !!b.duplicate_warning
    return true
  })

  const filters: Array<{ key: Filter; label: string }> = [
    { key: 'all',       label: 'All' },
    { key: 'mine',      label: 'Mine' },
    { key: 'missing',   label: 'Missing fields' },
    { key: 'duplicate', label: 'Possible duplicate' },
  ]

  return (
    <div className="p-5">
      <div className="flex gap-2 mb-5 flex-wrap">
        {filters.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={[
              'text-[11px] px-3 py-1.5 rounded-full border transition-colors',
              filter === f.key
                ? 'bg-[#0F0F0D] text-white border-[#0F0F0D]'
                : 'bg-white text-[#6B6A67] border-[#E5E4E0] hover:bg-[#F5F4F1]',
            ].join(' ')}
          >
            {f.label}
            {f.key === 'all' && bookings.length > 0 && (
              <span className="ml-1.5 opacity-60">({bookings.length})</span>
            )}
          </button>
        ))}
      </div>

      {loading && (
        <div className="text-[13px] text-[#9B9A97] py-10 text-center">Loading queue…</div>
      )}

      {error && (
        <div className="text-[13px] text-[#E24B4A] py-10 text-center">{error}</div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-[13px] text-[#9B9A97] py-10 text-center">
          {filter === 'all'
            ? 'Queue is empty. All bookings have been reviewed.'
            : 'No bookings match this filter.'}
        </div>
      )}

      {!loading && !error && filtered.map(booking => (
        <BookingQueueCard
          key={booking.id}
          booking={booking}
          currentUserEmail={userEmail}
          onApprove={async (id) => {
            await handleAction('approve', id)
          }}
          onReject={async (id) => {
            await handleAction('reject', id)
          }}
          onGroup={async (bookingId, tripId) => {
            await handleAction('group', bookingId, tripId)
          }}
          onDismissGroup={async (bookingId) => {
            await handleAction('dismiss_group', bookingId)
          }}
          onRefresh={load}
        />
      ))}
    </div>
  )
}
