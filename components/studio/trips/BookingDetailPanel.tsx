'use client'

import { useState } from 'react'
import type { Booking } from '@/lib/studio/types'

interface Props {
  booking: Booking
  allBookings: Booking[]  // for supersede — pick from same client's bookings
  userEmail: string
  onClose: () => void
  onSuperseded: () => void
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function FieldRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-[#F5F4F1] last:border-0">
      <span className="text-[11px] text-[#9B9A97] shrink-0 w-36">{label}</span>
      <span className="text-[11px] text-[#0F0F0D] text-right">
        {value !== null && value !== undefined && value !== '' ? String(value) : '—'}
      </span>
    </div>
  )
}

export function BookingDetailPanel({ booking, allBookings, userEmail, onClose, onSuperseded }: Props) {
  const [showSupersede, setShowSupersede]   = useState(false)
  const [selectedNewId, setSelectedNewId]   = useState<string>('')
  const [superseding, setSuperseding]       = useState(false)

  // Same client bookings that could supersede this one
  const sameClientBookings = allBookings.filter(b =>
    b.id !== booking.id &&
    b.client_name?.toLowerCase().trim() === booking.client_name?.toLowerCase().trim() &&
    b.hotel_name === booking.hotel_name
  )

  async function handleSupersede() {
    if (!selectedNewId) return
    setSuperseding(true)
    try {
      const res = await fetch(`/api/studio/trips/${booking.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'supersede', newBookingId: selectedNewId }),
      })
      if (!res.ok) throw new Error('Supersede failed')
      onSuperseded()
      onClose()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSuperseding(false)
    }
  }

  const refs = [
    booking.amadeus_ref && `PNR: ${booking.amadeus_ref}`,
    booking.hotel_ref   && `Hotel ref: ${booking.hotel_ref}`,
    booking.lhw_ref     && `LHW: ${booking.lhw_ref}`,
    booking.ottila_ref  && `Ottila: ${booking.ottila_ref}`,
    booking.onyx_ref    && `ONYX: ${booking.onyx_ref}`,
  ].filter(Boolean).join(' · ')

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-[420px] bg-white border-l border-[#E5E4E0] z-50 flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-[#E5E4E0]">
          <div>
            <p className="text-[13px] font-medium text-[#0F0F0D]">{booking.hotel_name ?? 'Unknown hotel'}</p>
            <p className="text-[11px] text-[#9B9A97] mt-0.5">{booking.client_name}</p>
          </div>
          <button
            onClick={onClose}
            className="text-[#9B9A97] hover:text-[#0F0F0D] ml-3"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {/* Status badge */}
          <div className="flex gap-2 mb-4">
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
              booking.status === 'confirmed'  ? 'bg-[#EAF3DE] text-[#27500A]' :
              booking.status === 'superseded' ? 'bg-[#F1EFE8] text-[#5F5E5A]' :
              booking.status === 'cancelled'  ? 'bg-[#FCEBEB] text-[#791F1F]' :
              'bg-[#FAEEDA] text-[#633806]'
            }`}>
              {booking.status}
            </span>
            {booking.vip_flag && <span className="text-[10px] bg-[#FAEEDA] text-[#633806] px-2 py-0.5 rounded-full font-medium">VIP</span>}
            {booking.vvip_flag && <span className="text-[10px] bg-[#FBEAF0] text-[#72243E] px-2 py-0.5 rounded-full font-medium">VVIP</span>}
          </div>

          {/* Core fields */}
          <div className="mb-4">
            <FieldRow label="Check-in"        value={formatDate(booking.check_in)} />
            <FieldRow label="Check-out"       value={formatDate(booking.check_out)} />
            <FieldRow label="Nights"          value={booking.nights} />
            <FieldRow label="Rooms"           value={booking.num_rooms} />
            <FieldRow label="Adults"          value={booking.num_adults} />
            <FieldRow label="Total cost"      value={booking.total_cost ? `${booking.currency} ${booking.total_cost.toLocaleString()}` : null} />
            <FieldRow label="References"      value={refs || null} />
            <FieldRow label="Booking source"  value={booking.booking_source} />
            <FieldRow label="Booked by"       value={booking.booked_by_name} />
            <FieldRow label="Cancel deadline" value={formatDate(booking.cancellation_deadline)} />
            <FieldRow label="Cancel policy"   value={booking.cancellation_policy} />
            <FieldRow label="Commission"      value={booking.commission_rate ? `${booking.commission_rate}%` : null} />
            <FieldRow label="Channel"         value={booking.commission_channel} />
            <FieldRow label="Special occasion" value={booking.special_occasion} />
          </div>

          {/* Notes */}
          {booking.notes && (
            <div className="mb-4">
              <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-2">Notes</p>
              <p className="text-[11px] text-[#6B6A67] leading-relaxed">{booking.notes}</p>
            </div>
          )}

          {/* Reviewed by */}
          {booking.reviewed_by && (
            <div className="mb-4">
              <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">Reviewed</p>
              <p className="text-[11px] text-[#9B9A97]">
                {booking.reviewed_by}
                {booking.reviewed_at && ` · ${formatDate(booking.reviewed_at)}`}
              </p>
            </div>
          )}

          {/* Supersede section */}
          {booking.status === 'confirmed' && sameClientBookings.length > 0 && (
            <div className="border-t border-[#E5E4E0] pt-4">
              {!showSupersede ? (
                <button
                  onClick={() => setShowSupersede(true)}
                  className="text-[11px] text-[#9B9A97] hover:text-[#0F0F0D] underline"
                >
                  Mark as superseded by another booking
                </button>
              ) : (
                <div>
                  <p className="text-[11px] font-medium text-[#0F0F0D] mb-2">
                    Which booking replaces this one?
                  </p>
                  <select
                    value={selectedNewId}
                    onChange={e => setSelectedNewId(e.target.value)}
                    className="w-full text-[11px] border border-[#E5E4E0] rounded px-2 py-1.5 mb-3 focus:outline-none"
                  >
                    <option value="">Select booking…</option>
                    {sameClientBookings.map(b => (
                      <option key={b.id} value={b.id}>
                        {b.hotel_name} · {b.check_in} – {b.check_out} · {b.currency} {b.total_cost?.toLocaleString()}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowSupersede(false)}
                      className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSupersede}
                      disabled={!selectedNewId || superseding}
                      className="text-[11px] bg-[#0F0F0D] text-white px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-40"
                    >
                      {superseding ? 'Marking…' : 'Confirm supersede'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
