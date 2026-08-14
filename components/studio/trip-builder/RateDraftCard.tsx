'use client'

import { useState } from 'react'

// Duplicated from lib/trip-builder/rate-extraction.ts rather than imported —
// that module executes server-only setup (Anthropic client init reading
// ANTHROPIC_API_KEY) at module scope, which must never end up in a client
// bundle. Keep this shape in sync by hand.
export interface FlightSegment {
  flight_number: string | null
  route:         string
  date:          string | null
  departure:     string | null
  arrival:       string | null
  duration:      string | null
  stops:         string | null
  aircraft:      string | null
  notes:         string | null
}

export interface ExtractedLineItem {
  category:            'accommodation' | 'activity' | 'transfer' | 'flight'
  leg_id:              string | null
  title:               string
  subtitle:            string | null
  details:             string | null
  unit:                'night' | 'person' | 'flat' | null
  quantity:            number | null
  rate_per_unit:       number | null
  // rate_per_unit always stays exactly as quoted — tax_percentage and
  // unit_count (rooms) only ever apply when computing the total, never
  // folded into the displayed per-unit rate itself.
  tax_percentage:      number | null
  unit_count:          number
  currency:            string | null
  inclusions:          string[]
  cancellation_policy: string | null
  segments:            FlightSegment[] | null
}

// Mirrors docx-builder.ts/html-builder.ts's itemSubtotal(PerUnit) exactly,
// so what the advisor sees here (before approval) matches what the
// generated document will show. Per-unit deliberately excludes unit_count,
// so a multi-room item can show "per room" and "all rooms" separately.
function computeTotalPerUnit(item: ExtractedLineItem): number | null {
  if (item.rate_per_unit == null) return null
  const base = item.unit === 'flat' || item.unit == null ? item.rate_per_unit : item.rate_per_unit * (item.quantity ?? 1)
  return item.tax_percentage ? base * (1 + item.tax_percentage / 100) : base
}

function computeTotal(item: ExtractedLineItem): number | null {
  const perUnit = computeTotalPerUnit(item)
  return perUnit == null ? null : perUnit * (item.unit_count || 1)
}

type DraftStatus = 'pending_review' | 'approved' | 'rejected'

interface Props {
  draftId:       string
  initialItems:  ExtractedLineItem[]
  initialStatus: DraftStatus
  // Called after approve/reject succeeds — a parent workspace uses this to
  // refresh the sidebar, since approving/rejecting changes trip_line_items
  // and the pending-drafts count outside the chat tool loop.
  onActivity?:   () => void
}

async function postAction(draftId: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/studio/trip-builder/rate-drafts/${draftId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Action failed')
  return data
}

function ItemRow({
  item, editing, onChange,
}: {
  item:     ExtractedLineItem
  editing:  boolean
  onChange: (item: ExtractedLineItem) => void
}) {
  if (!editing) {
    let rate = item.rate_per_unit != null
      ? `${item.currency ?? ''} ${item.rate_per_unit.toLocaleString()}${item.unit ? ` / ${item.unit}` : ''}`.trim()
      : null
    if (rate && item.unit_count && item.unit_count !== 1) rate += ` · ${item.unit_count} rooms`
    if (rate && item.tax_percentage) rate += ` · +${item.tax_percentage}% tax`
    const totalPerUnit = computeTotalPerUnit(item)
    const total = computeTotal(item)
    const hasMultipleUnits = !!item.unit_count && item.unit_count !== 1
    const taxSuffix = item.tax_percentage ? ' (incl. tax)' : ''
    return (
      <div className="py-1.5 border-b border-[#F0EFE9] last:border-b-0">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-medium text-[#0F0F0D]">{item.title}</p>
          {rate && <p className="text-[#6B6A67] shrink-0">{rate}</p>}
        </div>
        {item.subtitle && <p className="text-[#6B6A67]">{item.subtitle}</p>}
        {item.segments && item.segments.length > 0 && (
          <div className="text-[#6B6A67] text-[11px] mt-0.5 space-y-0.5">
            {item.segments.map((s, i) => (
              <p key={i}>
                {s.flight_number ? `${s.flight_number} · ` : ''}{s.route}
                {s.date ? ` · ${s.date}` : ''}
                {s.departure || s.arrival ? ` · ${s.departure ?? '?'}–${s.arrival ?? '?'}` : ''}
              </p>
            ))}
          </div>
        )}
        {item.inclusions.length > 0 && (
          <p className="text-[#9B9A97] text-[11px] mt-0.5">Incl: {item.inclusions.join(', ')}</p>
        )}
        {hasMultipleUnits && totalPerUnit != null && (
          <p className="text-[#6B6A67] text-[11px] mt-0.5">
            Per room{taxSuffix}: {item.currency ?? ''} {totalPerUnit.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
        )}
        {total != null && (
          <p className="text-[#0F0F0D] text-[11px] mt-0.5 font-medium">
            {hasMultipleUnits ? `${item.unit_count} rooms` : 'Total'}{taxSuffix}: {item.currency ?? ''} {total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="py-2 border-b border-[#F0EFE9] last:border-b-0 space-y-1.5">
      <input
        value={item.title}
        onChange={e => onChange({ ...item, title: e.target.value })}
        placeholder="Title"
        className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1"
      />
      <input
        value={item.subtitle ?? ''}
        onChange={e => onChange({ ...item, subtitle: e.target.value || null })}
        placeholder="Subtitle"
        className="w-full text-[12px] border border-[#E5E4E0] rounded px-2 py-1"
      />
      <div className="flex gap-1.5">
        <input
          value={item.currency ?? ''}
          onChange={e => onChange({ ...item, currency: e.target.value || null })}
          placeholder="Currency"
          className="w-16 text-[12px] border border-[#E5E4E0] rounded px-2 py-1"
        />
        <input
          type="number"
          value={item.rate_per_unit ?? ''}
          onChange={e => onChange({ ...item, rate_per_unit: e.target.value === '' ? null : Number(e.target.value) })}
          placeholder="Rate"
          className="flex-1 text-[12px] border border-[#E5E4E0] rounded px-2 py-1"
        />
        <select
          value={item.unit ?? ''}
          onChange={e => onChange({ ...item, unit: (e.target.value || null) as ExtractedLineItem['unit'] })}
          className="text-[12px] border border-[#E5E4E0] rounded px-1 py-1"
        >
          <option value="">unit</option>
          <option value="night">night</option>
          <option value="person">person</option>
          <option value="flat">flat</option>
        </select>
      </div>
      <div className="flex gap-1.5">
        <input
          type="number"
          value={item.tax_percentage ?? ''}
          onChange={e => onChange({ ...item, tax_percentage: e.target.value === '' ? null : Number(e.target.value) })}
          placeholder="Tax %"
          title="Exclusive tax/service % on top of the rate above — leave blank if the rate is already tax-inclusive"
          className="flex-1 text-[12px] border border-[#E5E4E0] rounded px-2 py-1"
        />
        <input
          type="number"
          value={item.unit_count ?? 1}
          onChange={e => onChange({ ...item, unit_count: e.target.value === '' ? 1 : Number(e.target.value) })}
          placeholder="Rooms"
          title="Number of rooms/units needed, if more than one"
          className="flex-1 text-[12px] border border-[#E5E4E0] rounded px-2 py-1"
        />
      </div>
    </div>
  )
}

export function RateDraftCard({ draftId, initialItems, initialStatus, onActivity }: Props) {
  const [items, setItems]     = useState(initialItems)
  const [status, setStatus]   = useState<DraftStatus>(initialStatus)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)

  async function handleApprove() {
    setBusy(true)
    setError(null)
    try {
      await postAction(draftId, { action: 'approve', items: editing ? items : undefined })
      setStatus('approved')
      setEditing(false)
      onActivity?.()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleReject() {
    setBusy(true)
    setError(null)
    try {
      await postAction(draftId, { action: 'reject' })
      setStatus('rejected')
      onActivity?.()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveEdits() {
    setBusy(true)
    setError(null)
    try {
      await postAction(draftId, { action: 'edit', extracted_json: items })
      setEditing(false)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-[85%] rounded-lg border border-[#E5E4E0] bg-white px-3 py-2.5 text-[12px]">
      <div className="flex items-center justify-between mb-1">
        <p className="font-medium text-[#0F0F0D]">Rate draft — {items.length} option{items.length === 1 ? '' : 's'}</p>
        {status !== 'pending_review' && (
          <span className={[
            'text-[10px] leading-none px-[7px] py-[4px] rounded-[10px] border',
            status === 'approved' ? 'bg-[#E9F5EC] text-[#1F7A3D] border-[#BFE3CB]' : 'bg-[#FBEAEA] text-[#B3261E] border-[#F2C6C4]',
          ].join(' ')}>
            {status === 'approved' ? 'Approved' : 'Rejected'}
          </span>
        )}
      </div>

      {items.map((item, i) => (
        <ItemRow
          key={i}
          item={item}
          editing={editing && status === 'pending_review'}
          onChange={updated => setItems(prev => prev.map((it, j) => (j === i ? updated : it)))}
        />
      ))}

      {error && <p className="text-[#E24B4A] mt-1.5">{error}</p>}

      {status === 'pending_review' && (
        <div className="flex gap-1.5 mt-2 pt-2 border-t border-[#F0EFE9]">
          {editing ? (
            <button onClick={handleSaveEdits} disabled={busy} className="text-[11px] bg-[#0F0F0D] text-white px-2.5 py-1 rounded disabled:opacity-50">
              Save edits
            </button>
          ) : (
            <button onClick={() => setEditing(true)} disabled={busy} className="text-[11px] border border-[#E5E4E0] px-2.5 py-1 rounded disabled:opacity-50">
              Edit
            </button>
          )}
          <button onClick={handleApprove} disabled={busy} className="text-[11px] bg-[#0F0F0D] text-white px-2.5 py-1 rounded disabled:opacity-50">
            Approve
          </button>
          <button onClick={handleReject} disabled={busy} className="text-[11px] text-[#B3261E] border border-[#F2C6C4] px-2.5 py-1 rounded disabled:opacity-50">
            Reject
          </button>
        </div>
      )}
    </div>
  )
}
