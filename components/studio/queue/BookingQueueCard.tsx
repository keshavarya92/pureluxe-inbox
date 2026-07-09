'use client'

import { useState } from 'react'
import type { QueueBooking } from '@/lib/studio/types'
import { hasBookingRef } from '@/lib/studio/trip-grouping'
import { DuplicateWarning } from './DuplicateWarning'
import { TripGroupSuggestion } from './TripGroupSuggestion'
import { FieldStatus } from './FieldStatus'

interface Props {
  booking: QueueBooking
  currentUserEmail: string
  onApprove: (id: string) => Promise<void>
  onReject: (id: string) => Promise<void>
  onGroup: (bookingId: string, tripId: string) => Promise<void>
  onDismissGroup: (bookingId: string) => Promise<void>
  onRefresh: () => void
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins  = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days  = Math.floor(diff / 86400000)
  if (mins < 1)   return 'just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

function formatDate(d: string | null): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function BookingQueueCard({
  booking,
  currentUserEmail,
  onApprove,
  onReject,
  onGroup,
  onDismissGroup,
  onRefresh,
}: Props) {
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editFields, setEditFields] = useState({
    hotel_name:            booking.hotel_name ?? '',
    city:                  booking.city ?? '',
    country:               booking.country ?? '',
    check_in:              booking.check_in ?? '',
    check_out:             booking.check_out ?? '',
    total_cost:            booking.total_cost?.toString() ?? '',
    currency:              booking.currency ?? '',
    amadeus_ref:           booking.amadeus_ref ?? '',
    hotel_ref:             booking.hotel_ref ?? '',
    cancellation_deadline: booking.cancellation_deadline ?? '',
    notes:                 booking.notes ?? '',
  })
  const [saving, setSaving] = useState(false)

  const canApprove = booking.missing_required.length === 0

  const refDisplay =
    booking.amadeus_ref ?? booking.hotel_ref ?? booking.lhw_ref ??
    booking.ottila_ref ?? booking.onyx_ref ?? null
  const refLabel =
    booking.amadeus_ref ? 'PNR' :
    booking.hotel_ref   ? 'Hotel ref' :
    booking.lhw_ref     ? 'LHW ref' :
    booking.ottila_ref  ? 'Ottila ref' :
    booking.onyx_ref    ? 'ONYX ref' : 'Ref'

  const hasDuplicate = !!booking.duplicate_warning

  async function handleApprove() {
    setLoading('approve')
    try {
      await onApprove(booking.id)
      onRefresh()
    } finally {
      setLoading(null)
    }
  }

  async function handleReject() {
    setLoading('reject')
    try {
      await onReject(booking.id)
      onRefresh()
    } finally {
      setLoading(null)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch(`/api/studio/queue/bookings/${booking.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...editFields,
          total_cost: editFields.total_cost ? Number(editFields.total_cost) : null,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      setEditing(false)
      onRefresh()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`bg-white border rounded-lg p-4 mb-3 ${hasDuplicate ? 'border-[#F4C0D1]' : 'border-[#E5E4E0]'}`}>

      {/* Duplicate warning */}
      {booking.duplicate_warning && (
        <DuplicateWarning warning={booking.duplicate_warning} />
      )}

      {/* Trip grouping suggestion */}
      {booking.trip_suggestion && !booking.trip_suggestion_dismissed && (
        <TripGroupSuggestion
          suggestion={booking.trip_suggestion}
          onGroup={async (tripId) => {
            await onGroup(booking.id, tripId)
            onRefresh()
          }}
          onDismiss={async () => {
            await onDismissGroup(booking.id)
            onRefresh()
          }}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-[13px] font-medium text-[#0F0F0D]">
            {booking.client_name ?? booking.client?.full_name ?? 'Unknown client'}
            {booking.hotel_name && (
              <span className="font-normal text-[#6B6A67]"> — {booking.hotel_name}</span>
            )}
          </p>
          <p className="text-[11px] text-[#9B9A97] mt-0.5">
            Extracted from {booking.booked_by_name ?? 'unknown inbox'} · {timeAgo(booking.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-3">
          {booking.vip_flag && (
            <span className="text-[10px] bg-[#FAEEDA] text-[#633806] px-2 py-0.5 rounded-full font-medium">VIP</span>
          )}
          {booking.vvip_flag && (
            <span className="text-[10px] bg-[#FBEAF0] text-[#72243E] px-2 py-0.5 rounded-full font-medium">VVIP</span>
          )}
          <span className="text-[10px] bg-[#FAEEDA] text-[#633806] px-2 py-0.5 rounded-full font-medium">
            Pending
          </span>
        </div>
      </div>

      {/* Fields grid */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {editing ? (
          <>
            {[
              { key: 'hotel_name',            label: 'Hotel name' },
              { key: 'check_in',              label: 'Check-in' },
              { key: 'check_out',             label: 'Check-out' },
              { key: 'amadeus_ref',           label: 'PNR' },
              { key: 'hotel_ref',             label: 'Hotel ref' },
              { key: 'total_cost',            label: 'Total cost' },
              { key: 'currency',              label: 'Currency' },
              { key: 'cancellation_deadline', label: 'Cancel deadline' },
              { key: 'city',                  label: 'City' },
            ].map(({ key, label }) => (
              <div key={key}>
                <p className="text-[10px] text-[#9B9A97] uppercase tracking-[0.04em] mb-[3px]">{label}</p>
                <input
                  type="text"
                  value={editFields[key as keyof typeof editFields]}
                  onChange={e => setEditFields(f => ({ ...f, [key]: e.target.value }))}
                  className="w-full text-[12px] text-[#0F0F0D] border border-[#E5E4E0] rounded px-2 py-1 focus:outline-none focus:border-[#9B9A97]"
                />
              </div>
            ))}
            <div className="col-span-3">
              <p className="text-[10px] text-[#9B9A97] uppercase tracking-[0.04em] mb-[3px]">Notes</p>
              <textarea
                value={editFields.notes}
                onChange={e => setEditFields(f => ({ ...f, notes: e.target.value }))}
                rows={3}
                className="w-full text-[12px] text-[#0F0F0D] border border-[#E5E4E0] rounded px-2 py-1 focus:outline-none focus:border-[#9B9A97] resize-none"
              />
            </div>
          </>
        ) : (
          <>
            <FieldStatus label="Check-in"  value={formatDate(booking.check_in)}  required missingLabel="Required" />
            <FieldStatus label="Check-out" value={formatDate(booking.check_out)} required missingLabel="Required" />
            <FieldStatus label={refLabel}  value={refDisplay}
              required={!hasBookingRef(booking)}
              missingLabel="No ref — check email"
            />
            <FieldStatus label="Total cost"
              value={booking.total_cost ? `${booking.currency ?? ''} ${booking.total_cost.toLocaleString()}`.trim() : null}
              missingLabel="Not captured"
            />
            <FieldStatus label="Cancellation deadline"
              value={formatDate(booking.cancellation_deadline)}
              missingLabel="Not found"
            />
            <FieldStatus label="Client"
              value={booking.client?.full_name ?? booking.client_name}
              required={!booking.client_id}
              missingLabel="Not linked"
            />
          </>
        )}
      </div>

      {/* Missing required warning */}
      {booking.missing_required.length > 0 && (
        <div className="text-[11px] text-[#E24B4A] mb-3">
          Required before approving: {booking.missing_required.map(f => f.label).join(', ')}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-3 border-t border-[#E5E4E0]">
        {editing ? (
          <>
            <button
              onClick={() => setEditing(false)}
              className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1] mr-auto"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-[11px] text-[#0F0F0D] bg-[#F5F4F1] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#E5E4E0] disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setEditing(true)}
              className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1] mr-auto"
            >
              Edit fields
            </button>
            <button
              onClick={handleReject}
              disabled={loading !== null}
              className="text-[11px] text-[#E24B4A] border border-[#F4C0D1] px-3 py-1.5 rounded-md hover:bg-[#FBEAF0] disabled:opacity-50"
            >
              {loading === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
            <button
              onClick={handleApprove}
              disabled={!canApprove || loading !== null}
              className="text-[11px] text-[#27500A] bg-[#EAF3DE] border border-[#B5D9A0] px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {loading === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          </>
        )}
      </div>

      {/* Expanded details */}
      {!editing && (
        <>
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-[11px] text-[#9B9A97] mt-2 hover:text-[#6B6A67]"
          >
            {expanded ? 'Hide details ↑' : 'View all fields ↓'}
          </button>
          {expanded && (
            <div className="mt-4 pt-4 border-t border-[#E5E4E0] grid grid-cols-3 gap-3">
              <FieldStatus label="City"           value={booking.city} />
              <FieldStatus label="Country"        value={booking.country} />
              <FieldStatus label="Chain"          value={booking.chain} />
              <FieldStatus label="Rooms"          value={booking.num_rooms} />
              <FieldStatus label="Adults"         value={booking.num_adults} />
              <FieldStatus label="Booking source" value={booking.booking_source} />
              <FieldStatus label="Commission %"   value={booking.commission_rate ? `${booking.commission_rate}%` : null} />
              <FieldStatus label="Special occasion" value={booking.special_occasion} />
              <FieldStatus label="Group"          value={booking.group_name} />
              {booking.notes && (
                <div className="col-span-3">
                  <p className="text-[10px] text-[#9B9A97] uppercase tracking-[0.04em] mb-1">Notes</p>
                  <p className="text-[11px] text-[#6B6A67] leading-relaxed">{booking.notes}</p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
