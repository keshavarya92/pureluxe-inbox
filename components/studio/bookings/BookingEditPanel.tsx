'use client'

import { useState, useEffect } from 'react'
import type { Booking, ClientRecord } from '@/lib/studio/types'

interface Props {
  bookingId: string
  userEmail: string
  onClose: () => void
  onSaved: () => void
}

type PanelMode = 'view' | 'edit' | 'merge' | 'supersede'

function FieldRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-[#F5F4F1] last:border-0">
      <span className="text-[11px] text-[#9B9A97] shrink-0 w-40">{label}</span>
      <span className="text-[11px] text-[#0F0F0D] text-right break-words max-w-[200px]">
        {value !== null && value !== undefined && value !== '' ? String(value) : '—'}
      </span>
    </div>
  )
}

function formatDate(d: string | null | undefined): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

const STATUS_OPTIONS = [
  'confirmed', 'pending_review', 'checked_out',
  'cancelled', 'superseded', 'enquiry', 'on_option',
]

export function BookingEditPanel({ bookingId, userEmail, onClose, onSaved }: Props) {
  const [booking, setBooking]   = useState<(Booking & { client: ClientRecord | null }) | null>(null)
  const [loading, setLoading]   = useState(true)
  const [mode, setMode]         = useState<PanelMode>('view')
  const [saving, setSaving]     = useState(false)
  const [mergeQuery, setMergeQuery]   = useState('')
  const [mergeResults, setMergeResults] = useState<Booking[]>([])
  const [mergeTarget, setMergeTarget] = useState<Booking | null>(null)
  const [supersedeQuery, setSupersedeQuery] = useState('')
  const [supersedeResults, setSupersedeResults] = useState<Booking[]>([])
  const [supersedeTarget, setSupersedeTarget] = useState<Booking | null>(null)

  // Edit fields state
  const [fields, setFields] = useState<Record<string, any>>({})

  useEffect(() => {
    setLoading(true)
    fetch(`/api/studio/bookings/${bookingId}`)
      .then(r => r.json())
      .then(d => {
        setBooking(d.booking)
        if (d.booking) {
          setFields({
            hotel_name:            d.booking.hotel_name ?? '',
            city:                  d.booking.city ?? '',
            country:               d.booking.country ?? '',
            chain:                 d.booking.chain ?? '',
            check_in:              d.booking.check_in ?? '',
            check_out:             d.booking.check_out ?? '',
            num_rooms:             d.booking.num_rooms ?? '',
            num_adults:            d.booking.num_adults ?? '',
            total_cost:            d.booking.total_cost ?? '',
            currency:              d.booking.currency ?? '',
            amadeus_ref:           d.booking.amadeus_ref ?? '',
            hotel_ref:             d.booking.hotel_ref ?? '',
            lhw_ref:               d.booking.lhw_ref ?? '',
            booking_source:        d.booking.booking_source ?? '',
            status:                d.booking.status ?? 'confirmed',
            cancellation_deadline: d.booking.cancellation_deadline ?? '',
            cancellation_policy:   d.booking.cancellation_policy ?? '',
            commission_rate:       d.booking.commission_rate ?? '',
            commission_channel:    d.booking.commission_channel ?? '',
            special_occasion:      d.booking.special_occasion ?? '',
            vip_flag:              d.booking.vip_flag ?? false,
            vvip_flag:             d.booking.vvip_flag ?? false,
            is_group_booking:      d.booking.is_group_booking ?? false,
            group_name:            d.booking.group_name ?? '',
            notes:                 d.booking.notes ?? '',
            internal_notes:        d.booking.internal_notes ?? '',
          })
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [bookingId])

  // Merge search
  useEffect(() => {
    if (mergeQuery.length < 2) { setMergeResults([]); return }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/studio/bookings?q=${encodeURIComponent(mergeQuery)}&page_size=8`)
      const { bookings } = await res.json()
      setMergeResults((bookings ?? []).filter((b: Booking) => b.id !== bookingId).slice(0, 6))
    }, 300)
    return () => clearTimeout(timer)
  }, [mergeQuery, bookingId])

  // Supersede search
  useEffect(() => {
    if (supersedeQuery.length < 2) { setSupersedeResults([]); return }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/studio/bookings?q=${encodeURIComponent(supersedeQuery)}&page_size=8`)
      const { bookings } = await res.json()
      setSupersedeResults((bookings ?? []).filter((b: Booking) => b.id !== bookingId).slice(0, 6))
    }, 300)
    return () => clearTimeout(timer)
  }, [supersedeQuery, bookingId])

  async function handleSave() {
    if (!booking) return
    setSaving(true)
    try {
      // Blank text inputs come back as '' — several fields (check_in, check_out,
      // cancellation_deadline, ...) map to date/typed DB columns that reject ''.
      // Coerce empty strings to null so "cleared" fields are stored as unset.
      const payload: Record<string, any> = {}
      for (const [key, value] of Object.entries(fields)) {
        payload[key] = typeof value === 'string' && value.trim() === '' ? null : value
      }
      payload.num_rooms       = fields.num_rooms       ? Number(fields.num_rooms)       : null
      payload.num_adults      = fields.num_adults      ? Number(fields.num_adults)      : null
      payload.total_cost      = fields.total_cost      ? Number(fields.total_cost)      : null
      payload.commission_rate = fields.commission_rate ? Number(fields.commission_rate) : null

      const res = await fetch(`/api/studio/bookings/${bookingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      setMode('view')
      onSaved()
      // Reload booking
      const updated = await fetch(`/api/studio/bookings/${bookingId}`).then(r => r.json())
      setBooking(updated.booking)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleMerge() {
    if (!mergeTarget) return
    setSaving(true)
    try {
      // Current booking is winner, mergeTarget is loser
      const res = await fetch(`/api/studio/bookings/${bookingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'merge', loserId: mergeTarget.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Merge failed')
      setMode('view')
      onSaved()
      onClose()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleSupersede() {
    if (!supersedeTarget) return
    setSaving(true)
    try {
      // Mark CURRENT booking as superseded by supersedeTarget
      const res = await fetch(`/api/studio/bookings/${bookingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'supersede', newBookingId: supersedeTarget.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Supersede failed')
      setMode('view')
      onSaved()
      onClose()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <>
        <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
        <div className="fixed right-0 top-0 h-full w-[480px] bg-white border-l border-[#E5E4E0] z-50 flex items-center justify-center shadow-xl">
          <p className="text-[13px] text-[#9B9A97]">Loading…</p>
        </div>
      </>
    )
  }

  if (!booking) {
    return (
      <>
        <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
        <div className="fixed right-0 top-0 h-full w-[480px] bg-white border-l border-[#E5E4E0] z-50 flex items-center justify-center shadow-xl">
          <p className="text-[13px] text-[#E24B4A]">Booking not found.</p>
        </div>
      </>
    )
  }

  const refs = [
    booking.amadeus_ref && `PNR: ${booking.amadeus_ref}`,
    booking.hotel_ref   && `Hotel: ${booking.hotel_ref}`,
    booking.lhw_ref     && `LHW: ${booking.lhw_ref}`,
    booking.ottila_ref  && `Ottila: ${booking.ottila_ref}`,
    booking.onyx_ref    && `ONYX: ${booking.onyx_ref}`,
  ].filter(Boolean).join(' · ')

  const EDIT_FIELDS = [
    { key: 'hotel_name',            label: 'Hotel name',         span: 2 },
    { key: 'city',                  label: 'City',               span: 1 },
    { key: 'country',               label: 'Country',            span: 1 },
    { key: 'chain',                 label: 'Chain',              span: 1 },
    { key: 'check_in',              label: 'Check-in',           span: 1 },
    { key: 'check_out',             label: 'Check-out',          span: 1 },
    { key: 'num_rooms',             label: 'Rooms',              span: 1 },
    { key: 'num_adults',            label: 'Adults',             span: 1 },
    { key: 'total_cost',            label: 'Total cost',         span: 1 },
    { key: 'currency',              label: 'Currency',           span: 1 },
    { key: 'amadeus_ref',           label: 'PNR',                span: 1 },
    { key: 'hotel_ref',             label: 'Hotel ref',          span: 1 },
    { key: 'lhw_ref',               label: 'LHW ref',            span: 1 },
    { key: 'booking_source',        label: 'Booking source',     span: 1 },
    { key: 'cancellation_deadline', label: 'Cancel deadline',    span: 1 },
    { key: 'cancellation_policy',   label: 'Cancel policy',      span: 2 },
    { key: 'commission_rate',       label: 'Commission %',       span: 1 },
    { key: 'commission_channel',    label: 'Commission channel', span: 1 },
    { key: 'special_occasion',      label: 'Special occasion',   span: 1 },
    { key: 'group_name',            label: 'Group name',         span: 1 },
  ]

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-[480px] bg-white border-l border-[#E5E4E0] z-50 flex flex-col shadow-xl">

        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-[#E5E4E0] shrink-0">
          <div className="flex-1 min-w-0 pr-3">
            <p className="text-[13px] font-medium text-[#0F0F0D] truncate">
              {booking.hotel_name ?? 'Unknown hotel'}
            </p>
            <p className="text-[11px] text-[#9B9A97] mt-0.5 truncate">
              {booking.client_name} · {booking.check_in} – {booking.check_out}
            </p>
          </div>
          <button onClick={onClose} className="text-[#9B9A97] hover:text-[#0F0F0D] shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-[#E5E4E0] shrink-0">
          {[
            { key: 'view',      label: 'Details'   },
            { key: 'edit',      label: 'Edit'      },
            { key: 'merge',     label: 'Merge dupe' },
            { key: 'supersede', label: 'Supersede' },
          ].map(m => (
            <button
              key={m.key}
              onClick={() => setMode(m.key as PanelMode)}
              className={`text-[11px] px-4 py-2.5 border-b-2 transition-colors ${
                mode === m.key
                  ? 'border-[#0F0F0D] text-[#0F0F0D] font-medium'
                  : 'border-transparent text-[#6B6A67] hover:text-[#0F0F0D]'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">

          {/* VIEW MODE */}
          {mode === 'view' && (
            <div className="p-5">
              {/* Status + badges */}
              <div className="flex gap-2 mb-4 flex-wrap">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                  booking.status === 'confirmed'  ? 'bg-[#EAF3DE] text-[#27500A]' :
                  booking.status === 'superseded' ? 'bg-[#F5F4F1] text-[#9B9A97]' :
                  booking.status === 'cancelled'  ? 'bg-[#FCEBEB] text-[#791F1F]' :
                  'bg-[#FAEEDA] text-[#633806]'
                }`}>{booking.status}</span>
                {booking.vip_flag  && <span className="text-[10px] bg-[#FAEEDA] text-[#633806] px-2 py-0.5 rounded-full font-medium">VIP</span>}
                {booking.vvip_flag && <span className="text-[10px] bg-[#FBEAF0] text-[#72243E] px-2 py-0.5 rounded-full font-medium">VVIP</span>}
                {booking.special_occasion && <span className="text-[10px] bg-[#E6F1FB] text-[#0C447C] px-2 py-0.5 rounded-full">{booking.special_occasion}</span>}
              </div>

              <FieldRow label="Client"          value={booking.client?.full_name ?? booking.client_name} />
              <FieldRow label="Hotel"           value={booking.hotel_name} />
              <FieldRow label="City"            value={booking.city} />
              <FieldRow label="Country"         value={booking.country} />
              <FieldRow label="Chain"           value={booking.chain} />
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
              <FieldRow label="Group"           value={booking.group_name} />
              {booking.notes && (
                <div className="mt-4 pt-4 border-t border-[#F5F4F1]">
                  <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-2">Notes</p>
                  <p className="text-[11px] text-[#6B6A67] leading-relaxed">{booking.notes}</p>
                </div>
              )}
              {booking.internal_notes && (
                <div className="mt-3">
                  <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-2">Internal notes</p>
                  <p className="text-[11px] text-[#6B6A67] leading-relaxed">{booking.internal_notes}</p>
                </div>
              )}
              {booking.reviewed_by && (
                <div className="mt-4 pt-4 border-t border-[#F5F4F1]">
                  <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">Reviewed</p>
                  <p className="text-[11px] text-[#9B9A97]">{booking.reviewed_by} · {formatDate(booking.reviewed_at)}</p>
                </div>
              )}
            </div>
          )}

          {/* EDIT MODE */}
          {mode === 'edit' && (
            <div className="p-5">
              <div className="grid grid-cols-2 gap-3 mb-4">
                {EDIT_FIELDS.map(f => (
                  <div key={f.key} className={f.span === 2 ? 'col-span-2' : ''}>
                    <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">{f.label}</p>
                    <input
                      type="text"
                      value={String(fields[f.key] ?? '')}
                      onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                      className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none focus:border-[#9B9A97]"
                    />
                  </div>
                ))}

                {/* Status dropdown */}
                <div>
                  <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">Status</p>
                  <select
                    value={fields.status}
                    onChange={e => setFields(prev => ({ ...prev, status: e.target.value }))}
                    className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none"
                  >
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>

                {/* Checkboxes */}
                <div className="col-span-2 flex gap-4">
                  {[
                    { key: 'vip_flag',        label: 'VIP' },
                    { key: 'vvip_flag',       label: 'VVIP' },
                    { key: 'is_group_booking', label: 'Group booking' },
                  ].map(f => (
                    <label key={f.key} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!fields[f.key]}
                        onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.checked }))}
                        className="rounded"
                      />
                      <span className="text-[12px] text-[#0F0F0D]">{f.label}</span>
                    </label>
                  ))}
                </div>

                {/* Notes */}
                <div className="col-span-2">
                  <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">Notes</p>
                  <textarea
                    value={String(fields.notes ?? '')}
                    onChange={e => setFields(prev => ({ ...prev, notes: e.target.value }))}
                    rows={3}
                    className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none resize-none"
                  />
                </div>
                <div className="col-span-2">
                  <p className="text-[10px] text-[#9B9A97] uppercase tracking-wider mb-1">Internal notes</p>
                  <textarea
                    value={String(fields.internal_notes ?? '')}
                    onChange={e => setFields(prev => ({ ...prev, internal_notes: e.target.value }))}
                    rows={2}
                    className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1.5 focus:outline-none resize-none"
                  />
                </div>
              </div>

              <div className="flex gap-2 pt-3 border-t border-[#E5E4E0]">
                <button
                  onClick={() => setMode('view')}
                  className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1] mr-auto"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="text-[11px] bg-[#0F0F0D] text-white px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          )}

          {/* MERGE MODE */}
          {mode === 'merge' && (
            <div className="p-5">
              <p className="text-[12px] font-medium text-[#0F0F0D] mb-2">Merge duplicate bookings</p>
              <p className="text-[11px] text-[#9B9A97] mb-4">
                This booking is the winner. Search for the duplicate to deactivate.
              </p>
              <input
                type="text"
                placeholder="Search by client name, hotel, or PNR…"
                value={mergeQuery}
                onChange={e => setMergeQuery(e.target.value)}
                className="w-full text-[12px] border border-[#E5E4E0] rounded px-3 py-2 mb-3 focus:outline-none focus:border-[#9B9A97]"
              />
              {mergeResults.map(b => (
                <button
                  key={b.id}
                  onClick={() => setMergeTarget(b)}
                  className={`w-full text-left px-3 py-2 rounded mb-1 border transition-colors ${
                    mergeTarget?.id === b.id ? 'border-[#0F0F0D] bg-[#F5F4F1]' : 'border-[#E5E4E0] hover:bg-[#F5F4F1]'
                  }`}
                >
                  <p className="text-[12px] font-medium text-[#0F0F0D]">{b.client_name}</p>
                  <p className="text-[11px] text-[#9B9A97]">{b.hotel_name} · {b.check_in} – {b.check_out} · {b.amadeus_ref ?? b.hotel_ref ?? '—'}</p>
                </button>
              ))}
              {mergeTarget && (
                <div className="mt-3 p-3 bg-[#FAEEDA] border border-[#FAC775] rounded-md">
                  <p className="text-[11px] font-medium text-[#633806] mb-1">Confirm merge</p>
                  <p className="text-[11px] text-[#633806]">
                    <span className="font-medium">{mergeTarget.client_name} — {mergeTarget.hotel_name}</span> will be marked as a duplicate and deactivated. This booking stays active.
                  </p>
                </div>
              )}
              <div className="flex gap-2 mt-4 pt-3 border-t border-[#E5E4E0]">
                <button onClick={() => setMode('view')} className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1] mr-auto">
                  Cancel
                </button>
                <button
                  onClick={handleMerge}
                  disabled={!mergeTarget || saving}
                  className="text-[11px] bg-[#E24B4A] text-white px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-40"
                >
                  {saving ? 'Merging…' : 'Confirm merge'}
                </button>
              </div>
            </div>
          )}

          {/* SUPERSEDE MODE */}
          {mode === 'supersede' && (
            <div className="p-5">
              <p className="text-[12px] font-medium text-[#0F0F0D] mb-2">Mark as superseded</p>
              <p className="text-[11px] text-[#9B9A97] mb-4">
                This booking was replaced. Search for the newer booking that replaced it.
              </p>
              <input
                type="text"
                placeholder="Search by client name, hotel, or PNR…"
                value={supersedeQuery}
                onChange={e => setSupersedeQuery(e.target.value)}
                className="w-full text-[12px] border border-[#E5E4E0] rounded px-3 py-2 mb-3 focus:outline-none focus:border-[#9B9A97]"
              />
              {supersedeResults.map(b => (
                <button
                  key={b.id}
                  onClick={() => setSupersedeTarget(b)}
                  className={`w-full text-left px-3 py-2 rounded mb-1 border transition-colors ${
                    supersedeTarget?.id === b.id ? 'border-[#0F0F0D] bg-[#F5F4F1]' : 'border-[#E5E4E0] hover:bg-[#F5F4F1]'
                  }`}
                >
                  <p className="text-[12px] font-medium text-[#0F0F0D]">{b.client_name}</p>
                  <p className="text-[11px] text-[#9B9A97]">{b.hotel_name} · {b.check_in} – {b.check_out} · {b.amadeus_ref ?? b.hotel_ref ?? '—'}</p>
                </button>
              ))}
              {supersedeTarget && (
                <div className="mt-3 p-3 bg-[#E6F1FB] border border-[#B5D4F4] rounded-md">
                  <p className="text-[11px] font-medium text-[#0C447C] mb-1">Confirm supersede</p>
                  <p className="text-[11px] text-[#0C447C]">
                    This booking will be marked as superseded by <span className="font-medium">{supersedeTarget.hotel_name} ({supersedeTarget.check_in})</span>.
                  </p>
                </div>
              )}
              <div className="flex gap-2 mt-4 pt-3 border-t border-[#E5E4E0]">
                <button onClick={() => setMode('view')} className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1] mr-auto">
                  Cancel
                </button>
                <button
                  onClick={handleSupersede}
                  disabled={!supersedeTarget || saving}
                  className="text-[11px] bg-[#0F0F0D] text-white px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-40"
                >
                  {saving ? 'Marking…' : 'Confirm supersede'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
