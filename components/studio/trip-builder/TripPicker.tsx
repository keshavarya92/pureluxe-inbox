'use client'

import { useState, useEffect, useRef } from 'react'

interface TripSummary {
  id:           string
  title:        string | null
  status:       'building' | 'quoted' | 'confirmed' | 'itinerary_sent'
  client_name:  string | null
  destinations: string[]
  updated_at:   string
}

const STATUS_LABELS: Record<string, string> = {
  building:       'Building',
  quoted:         'Quoted',
  confirmed:      'Confirmed',
  itinerary_sent: 'Itinerary sent',
}

interface Props {
  onSelect: (tripId: string) => void
}

export function TripPicker({ onSelect }: Props) {
  const [open, setOpen]       = useState(false)
  const [trips, setTrips]     = useState<TripSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [query, setQuery]     = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    fetch('/api/studio/trip-builder/trips')
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to load trips')
        setTrips(data.trips)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const filtered = (trips ?? []).filter(t => {
    if (!query.trim()) return true
    const haystack = `${t.client_name ?? ''} ${t.title ?? ''} ${t.destinations.join(' ')}`.toLowerCase()
    return haystack.includes(query.trim().toLowerCase())
  })

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className="text-[11px] text-[#6B6A67] hover:text-[#0F0F0D]"
      >
        Browse trips
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-[280px] max-h-[360px] overflow-y-auto bg-white border border-[#E5E4E0] rounded-lg shadow-lg z-10">
          <div className="p-2 border-b border-[#E5E4E0] sticky top-0 bg-white">
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search client or destination…"
              className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none focus:border-[#9B9A97]"
            />
          </div>

          {loading && <p className="text-[12px] text-[#9B9A97] px-3 py-3">Loading…</p>}
          {error && <p className="text-[12px] text-[#E24B4A] px-3 py-3">{error}</p>}
          {!loading && !error && filtered.length === 0 && (
            <p className="text-[12px] text-[#9B9A97] px-3 py-3">No trips found.</p>
          )}
          {filtered.map(trip => (
            <button
              key={trip.id}
              onClick={() => { onSelect(trip.id); setOpen(false) }}
              className="w-full text-left px-3 py-2 hover:bg-[#F5F4F1] border-b border-[#F0EFE9] last:border-b-0"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] font-medium text-[#0F0F0D] truncate">{trip.client_name ?? 'Unknown client'}</p>
                <span className="text-[10px] text-[#9B9A97] shrink-0">{STATUS_LABELS[trip.status]}</span>
              </div>
              <p className="text-[11px] text-[#6B6A67] truncate">
                {trip.title || trip.destinations.join(', ') || 'No legs yet'}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
