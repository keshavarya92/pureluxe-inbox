'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Booking } from '@/lib/studio/types'
import type { BookingSort } from '@/lib/studio/queries'
import { BookingRow } from '@/components/studio/bookings/BookingRow'
import { BookingEditPanel } from '@/components/studio/bookings/BookingEditPanel'

type StatusFilter = 'all' | 'confirmed' | 'pending_review' | 'checked_out' | 'cancelled' | 'superseded'
type SortOption  = BookingSort

const COLUMNS: Array<{ key: string; label: string; sortable: boolean }> = [
  { key: 'client_name',    label: 'Client',     sortable: true  },
  { key: 'hotel_name',     label: 'Hotel',      sortable: true  },
  { key: 'check_in',       label: 'Check-in',   sortable: true  },
  { key: 'check_out',      label: 'Check-out',  sortable: true  },
  { key: 'nights',         label: 'Nights',     sortable: false },
  { key: 'total_cost',     label: 'Cost',       sortable: true  },
  { key: 'status',         label: 'Status',     sortable: false },
  { key: 'booked_by_name', label: 'Booked by',  sortable: false },
  { key: 'amadeus_ref',    label: 'Ref',        sortable: false },
]

function toSortOption(field: string, dir: 'asc' | 'desc'): SortOption {
  const key = `${field}_${dir}` as SortOption
  const valid: SortOption[] = [
    'check_in_asc', 'check_in_desc',
    'client_name_asc', 'client_name_desc',
    'hotel_name_asc', 'hotel_name_desc',
    'created_at_desc',
    'total_cost_desc', 'total_cost_asc',
  ]
  return valid.includes(key) ? key : 'check_in_desc'
}

export default function BookingsPage() {
  const [bookings, setBookings]         = useState<Booking[]>([])
  const [total, setTotal]               = useState(0)
  const [page, setPage]                 = useState(1)
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [selectedId, setSelectedId]     = useState<string | null>(null)
  const [userEmail, setUserEmail]       = useState('')
  const [query, setQuery]               = useState('')
  const [status, setStatus]             = useState<StatusFilter>('all')
  const [sortField, setSortField]       = useState<string>('check_in')
  const [sortDir, setSortDir]           = useState<'asc' | 'desc'>('desc')
  const [dateFrom, setDateFrom]         = useState('')
  const [dateTo, setDateTo]             = useState('')

  const PAGE_SIZE = 50

  function handleSort(field: string) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const load = useCallback(async (p = 1) => {
    setLoading(true)
    setError(null)
    try {
      const sort = toSortOption(sortField, sortDir)
      const params = new URLSearchParams({
        q:      query,
        status,
        sort,
        page:   String(p),
      })
      if (dateFrom) params.set('from', dateFrom)
      if (dateTo)   params.set('to', dateTo)

      const res = await fetch(`/api/studio/bookings?${params}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed to load bookings (${res.status})`)
      setBookings(data.bookings ?? [])
      setTotal(data.total ?? 0)
      setUserEmail(data.userEmail ?? '')
      setPage(p)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [query, status, sortField, sortDir, dateFrom, dateTo])

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => load(1), 300)
    return () => clearTimeout(timer)
  }, [load])

  const statusFilters: Array<{ key: StatusFilter; label: string }> = [
    { key: 'all',           label: 'All' },
    { key: 'confirmed',     label: 'Confirmed' },
    { key: 'pending_review', label: 'Pending review' },
    { key: 'checked_out',   label: 'Checked out' },
    { key: 'cancelled',     label: 'Cancelled' },
    { key: 'superseded',    label: 'Superseded' },
  ]

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar */}
      <div className="bg-white border-b border-[#E5E4E0] px-5 py-3 shrink-0">
        {/* Search + sort row */}
        <div className="flex items-center gap-3 mb-3">
          <input
            type="text"
            placeholder="Search client, hotel, PNR, city…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="flex-1 text-[12px] bg-[#F5F4F1] border-none rounded-md px-3 py-2 focus:outline-none"
          />
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="text-[11px] border border-[#E5E4E0] rounded px-2 py-2 focus:outline-none shrink-0"
            title="Check-in from"
          />
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="text-[11px] border border-[#E5E4E0] rounded px-2 py-2 focus:outline-none shrink-0"
            title="Check-in to"
          />
        </div>

        {/* Status filters */}
        <div className="flex gap-2 flex-wrap">
          {statusFilters.map(f => (
            <button
              key={f.key}
              onClick={() => setStatus(f.key)}
              className={`text-[11px] px-3 py-1 rounded-full border transition-colors ${
                status === f.key
                  ? 'bg-[#0F0F0D] text-white border-[#0F0F0D]'
                  : 'border-[#E5E4E0] text-[#6B6A67] hover:bg-[#F5F4F1]'
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-[#9B9A97] self-center">
            {total.toLocaleString()} booking{total !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="text-[13px] text-[#9B9A97] text-center py-10">Loading…</div>
        )}
        {error && (
          <div className="text-[13px] text-[#E24B4A] text-center py-10">{error}</div>
        )}
        {!loading && !error && bookings.length === 0 && (
          <div className="text-[13px] text-[#9B9A97] text-center py-10">No bookings found.</div>
        )}
        {!loading && !error && bookings.length > 0 && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-white border-b border-[#E5E4E0] z-10">
              <tr>
                {COLUMNS.map(col => (
                  <th
                    key={col.key}
                    onClick={col.sortable ? () => handleSort(col.key) : undefined}
                    className={`px-4 py-2.5 text-left text-[10px] text-[#9B9A97] font-medium uppercase tracking-wider whitespace-nowrap ${
                      col.sortable ? 'cursor-pointer hover:text-[#0F0F0D] select-none' : ''
                    }`}
                  >
                    {col.label}
                    {col.sortable && sortField === col.key && (
                      <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                    )}
                    {col.sortable && sortField !== col.key && (
                      <span className="ml-1 opacity-30">↕</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bookings.map(b => (
                <BookingRow
                  key={b.id}
                  booking={b}
                  isSelected={b.id === selectedId}
                  onClick={() => setSelectedId(b.id === selectedId ? null : b.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="shrink-0 border-t border-[#E5E4E0] bg-white px-5 py-3 flex items-center justify-between">
          <p className="text-[11px] text-[#9B9A97]">
            Page {page} of {totalPages} · {total.toLocaleString()} total
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => load(page - 1)}
              disabled={page <= 1 || loading}
              className="text-[11px] border border-[#E5E4E0] px-3 py-1.5 rounded hover:bg-[#F5F4F1] disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => load(page + 1)}
              disabled={page >= totalPages || loading}
              className="text-[11px] border border-[#E5E4E0] px-3 py-1.5 rounded hover:bg-[#F5F4F1] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Detail/edit panel */}
      {selectedId && (
        <BookingEditPanel
          bookingId={selectedId}
          userEmail={userEmail}
          onClose={() => setSelectedId(null)}
          onSaved={() => load(page)}
        />
      )}
    </div>
  )
}
