'use client'

import { useState, useEffect, useCallback } from 'react'

// Duplicated from lib/trip-builder/queries.ts rather than imported — that
// module pulls in lib/supabase.ts, which initializes a service-role client
// at module scope and must never end up in a client bundle. Keep these
// shapes in sync by hand.

interface TripLeg {
  id:               string
  sequence_order:   number
  destination:      string
  check_in:         string | null
  check_out:        string | null
  itinerary_status: 'not_started' | 'drafted' | 'confirmed'
}

interface TripLineItem {
  id:            string
  leg_id:        string | null
  category:      'accommodation' | 'activity' | 'transfer' | 'flight'
  title:         string
  subtitle:      string | null
  unit:          string | null
  quantity:      number | null
  rate_per_unit: number | null
  tax_percentage: number | null
  unit_count:    number
  currency:      string | null
  inclusions:    string[]
  status:        'pending' | 'confirmed'
  selected:      boolean
}

interface TripLineItemDraft {
  id:         string
  leg_id:     string | null
  status:     'pending_review' | 'approved' | 'rejected'
  created_at: string
}

interface TripDocument {
  id:                string
  type:              'itinerary' | 'rate_sheet'
  file_path:         string
  generated_at:      string
  source_updated_at: string
  stale:             boolean
}

interface SidebarData {
  trip: {
    id:     string
    status: 'building' | 'quoted' | 'confirmed' | 'itinerary_sent'
    title:  string | null
  }
  client_name:                string | null
  legs:                       TripLeg[]
  line_items:                 TripLineItem[]
  pending_drafts:             TripLineItemDraft[]
  documents:                  TripDocument[]
  running_total_by_currency:  Record<string, number>
}

type Tab = 'glance' | 'rates' | 'documents'

const STATUS_LABELS: Record<string, string> = {
  building:       'Building',
  quoted:         'Quoted',
  confirmed:      'Confirmed',
  itinerary_sent: 'Itinerary sent',
  not_started:    'Not started',
  drafted:        'Drafted',
  pending:        'Pending',
  pending_review: 'Pending review',
  approved:       'Approved',
  rejected:       'Rejected',
}

function Badge({ tone, children }: { tone: 'neutral' | 'amber' | 'green'; children: React.ReactNode }) {
  const toneClasses = {
    neutral: 'bg-[#F1EFE8] text-[#6B6A67] border-[#E5E4E0]',
    amber:   'bg-[#FEF3C7] text-[#92400E] border-[#FDE68A]',
    green:   'bg-[#E9F5EC] text-[#1F7A3D] border-[#BFE3CB]',
  }[tone]
  return (
    <span className={`inline-block text-[10px] leading-none px-[6px] py-[3px] rounded-[8px] border shrink-0 ${toneClasses}`}>
      {children}
    </span>
  )
}

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

// The per-unit rate always shown exactly as quoted; tax/room-count are
// noted alongside it, matching how the generated document displays it —
// see docx-builder.ts/html-builder.ts's itemSubtotal for the actual total.
function formatRate(item: TripLineItem): string | null {
  if (item.rate_per_unit == null) return null
  const qty = item.quantity && item.quantity !== 1 ? `${item.quantity} × ` : ''
  let rate = `${qty}${item.currency ?? ''} ${item.rate_per_unit.toLocaleString()}${item.unit ? ` / ${item.unit}` : ''}`.trim()
  if (item.unit_count && item.unit_count !== 1) rate += ` · ${item.unit_count} rooms`
  if (item.tax_percentage) rate += ` · +${item.tax_percentage}% tax`
  return rate
}

// Tax-inclusive total for ONE room/unit — excludes unit_count so a
// multi-room item can show "per room" and "all rooms" separately.
function computeItemTotalPerUnit(item: TripLineItem): number | null {
  if (item.rate_per_unit == null) return null
  const base = item.unit === 'flat' || item.unit == null ? item.rate_per_unit : item.rate_per_unit * (item.quantity ?? 1)
  return item.tax_percentage ? base * (1 + item.tax_percentage / 100) : base
}

function computeItemTotal(item: TripLineItem): number | null {
  const perUnit = computeItemTotalPerUnit(item)
  return perUnit == null ? null : perUnit * (item.unit_count || 1)
}

function AtAGlanceTab({ data }: { data: SidebarData }) {
  const itemsByLeg = new Map<string, TripLineItem[]>()
  const tripLevelItems: TripLineItem[] = []
  for (const item of data.line_items) {
    if (item.leg_id) {
      if (!itemsByLeg.has(item.leg_id)) itemsByLeg.set(item.leg_id, [])
      itemsByLeg.get(item.leg_id)!.push(item)
    } else {
      tripLevelItems.push(item)
    }
  }

  const totalEntries = Object.entries(data.running_total_by_currency)

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] text-[#9B9A97] mb-1">Client</p>
        <p className="text-[13px] font-medium text-[#0F0F0D]">{data.client_name ?? 'Unknown'}</p>
      </div>

      {data.legs.length === 0 && (
        <p className="text-[12px] text-[#9B9A97]">No legs yet — add one from the chat.</p>
      )}

      {data.legs.map(leg => (
        <div key={leg.id} className="border border-[#E5E4E0] rounded-lg p-2.5">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="text-[13px] font-medium text-[#0F0F0D]">{leg.destination}</p>
            <Badge tone={leg.itinerary_status === 'confirmed' ? 'green' : 'neutral'}>
              {STATUS_LABELS[leg.itinerary_status]}
            </Badge>
          </div>
          {(leg.check_in || leg.check_out) && (
            <p className="text-[11px] text-[#9B9A97] mb-1.5">{leg.check_in ?? '?'} → {leg.check_out ?? '?'}</p>
          )}
          {(itemsByLeg.get(leg.id) ?? []).length === 0 ? (
            <p className="text-[11px] text-[#9B9A97]">No rates yet</p>
          ) : (
            <div className="space-y-1 mt-1">
              {(itemsByLeg.get(leg.id) ?? []).map(item => (
                <div key={item.id} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-[#3A3A38]">{item.title}{item.selected ? ' ★' : ''}</span>
                  <Badge tone={item.status === 'confirmed' ? 'green' : 'amber'}>{STATUS_LABELS[item.status]}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {tripLevelItems.length > 0 && (
        <div className="border border-[#E5E4E0] rounded-lg p-2.5">
          <p className="text-[13px] font-medium text-[#0F0F0D] mb-1">Trip-wide (flights/transfers)</p>
          <div className="space-y-1">
            {tripLevelItems.map(item => (
              <div key={item.id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-[#3A3A38]">{item.title}{item.selected ? ' ★' : ''}</span>
                <Badge tone={item.status === 'confirmed' ? 'green' : 'amber'}>{STATUS_LABELS[item.status]}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-[#E5E4E0] pt-3">
        <p className="text-[11px] text-[#9B9A97] mb-1">Running total (confirmed/selected only)</p>
        {totalEntries.length === 0 ? (
          <p className="text-[12px] text-[#9B9A97]">Nothing confirmed yet</p>
        ) : (
          <div className="space-y-0.5">
            {totalEntries.map(([currency, amount]) => (
              <p key={currency} className="text-[13px] font-medium text-[#0F0F0D]">{formatMoney(amount, currency)}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RatesTab({ tripId, data, onRemoved }: { tripId: string; data: SidebarData; onRemoved: () => void }) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId]           = useState<string | null>(null)
  const [error, setError]                     = useState<string | null>(null)

  async function handleConfirmRemove(itemId: string) {
    setDeletingId(itemId)
    setError(null)
    try {
      const res = await fetch(`/api/studio/trip-builder/trips/${tripId}/line-items/${itemId}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to remove')
      setPendingDeleteId(null)
      onRemoved()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-4">
      {data.pending_drafts.length > 0 && (
        <div>
          <p className="text-[11px] text-[#9B9A97] mb-1.5">Awaiting approval ({data.pending_drafts.length})</p>
          <p className="text-[11px] text-[#6B6A67]">Review pending drafts in the chat.</p>
        </div>
      )}

      {error && <p className="text-[12px] text-[#E24B4A]">{error}</p>}

      {data.line_items.length === 0 ? (
        <p className="text-[12px] text-[#9B9A97]">No rates on this trip yet.</p>
      ) : (
        <div className="space-y-2">
          {data.line_items.map(item => (
            <div key={item.id} className="border border-[#E5E4E0] rounded-lg p-2.5 text-[12px]">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="font-medium text-[#0F0F0D]">{item.title}{item.selected ? ' ★' : ''}</p>
                <Badge tone={item.status === 'confirmed' ? 'green' : 'amber'}>{STATUS_LABELS[item.status]}</Badge>
              </div>
              <p className="text-[10px] text-[#9B9A97] uppercase tracking-wide mb-1">{item.category}</p>
              {item.subtitle && <p className="text-[#6B6A67]">{item.subtitle}</p>}
              {formatRate(item) && <p className="text-[#3A3A38] mt-1">{formatRate(item)}</p>}
              {item.inclusions.length > 0 && (
                <p className="text-[#9B9A97] text-[11px] mt-1">Incl: {item.inclusions.join(', ')}</p>
              )}
              {(() => {
                const total = computeItemTotal(item)
                if (total == null) return null
                const hasMultipleUnits = !!item.unit_count && item.unit_count !== 1
                const taxSuffix = item.tax_percentage ? ' (incl. tax)' : ''
                const perUnit = computeItemTotalPerUnit(item)
                return (
                  <>
                    {hasMultipleUnits && perUnit != null && (
                      <p className="text-[#6B6A67] text-[11px] mt-1">
                        Per room{taxSuffix}: {item.currency ?? ''} {perUnit.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </p>
                    )}
                    <p className="text-[#0F0F0D] text-[11px] mt-1 font-medium">
                      {hasMultipleUnits ? `${item.unit_count} rooms` : 'Total'}{taxSuffix}: {item.currency ?? ''} {total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </p>
                  </>
                )
              })()}

              <div className="mt-2 pt-2 border-t border-[#F0EFE9]">
                {pendingDeleteId === item.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[#B3261E]">Remove this item?</span>
                    <button
                      onClick={() => handleConfirmRemove(item.id)}
                      disabled={deletingId === item.id}
                      className="text-[11px] text-[#B3261E] border border-[#F2C6C4] rounded px-2 py-0.5 disabled:opacity-50"
                    >
                      {deletingId === item.id ? 'Removing…' : 'Confirm'}
                    </button>
                    <button onClick={() => setPendingDeleteId(null)} className="text-[11px] text-[#6B6A67]">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setPendingDeleteId(item.id)} className="text-[11px] text-[#9B9A97] hover:text-[#B3261E]">
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Fixed/full-viewport regardless of the sidebar's own 320px width — a
// document page doesn't fit usefully in that column, so preview opens as
// an overlay instead of rendering inline.
function DocumentPreviewModal({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-8" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl h-full max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-[#E5E4E0] shrink-0">
          <p className="text-[12px] font-medium text-[#0F0F0D]">Preview</p>
          <button onClick={onClose} className="text-[12px] text-[#6B6A67] hover:text-[#0F0F0D]">Close</button>
        </div>
        <iframe
          src={`/api/studio/trip-builder/documents/${documentId}/preview`}
          className="flex-1 w-full"
          style={{ border: 'none' }}
          title="Document preview"
        />
      </div>
    </div>
  )
}

function DocumentsTab({ tripId, data, onGenerated }: { tripId: string; data: SidebarData; onGenerated: () => void }) {
  const [generating, setGenerating] = useState<'itinerary' | 'rate_sheet' | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [warnings, setWarnings]     = useState<string[]>([])
  const [previewDocId, setPreviewDocId] = useState<string | null>(null)

  async function handleGenerate(type: 'itinerary' | 'rate_sheet') {
    setGenerating(type)
    setError(null)
    setWarnings([])
    try {
      const res = await fetch(`/api/studio/trip-builder/trips/${tripId}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Generation failed')
      setWarnings(json.warnings ?? [])
      onGenerated()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setGenerating(null)
    }
  }

  return (
    <div className="space-y-3">
      {data.documents.length === 0 ? (
        <p className="text-[12px] text-[#9B9A97]">No documents generated yet.</p>
      ) : (
        data.documents.map(doc => (
          <div key={doc.id} className="border border-[#E5E4E0] rounded-lg p-2.5 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium text-[#0F0F0D] capitalize">{doc.type.replace('_', ' ')}</p>
              {doc.stale && <Badge tone="amber">Stale</Badge>}
            </div>
            <p className="text-[11px] text-[#9B9A97] mt-1">Generated {new Date(doc.generated_at).toLocaleString()}</p>
            <div className="flex items-center gap-3 mt-1.5 text-[11px]">
              <button onClick={() => setPreviewDocId(doc.id)} className="text-[#0F0F0D] underline hover:no-underline">
                Preview
              </button>
              <a href={`/api/studio/trip-builder/documents/${doc.id}/download?format=docx`} target="_blank" rel="noreferrer" className="text-[#0F0F0D] underline hover:no-underline">
                Word
              </a>
              <a href={`/api/studio/trip-builder/documents/${doc.id}/download?format=pdf`} target="_blank" rel="noreferrer" className="text-[#0F0F0D] underline hover:no-underline">
                PDF
              </a>
            </div>
          </div>
        ))
      )}

      {previewDocId && (
        <DocumentPreviewModal documentId={previewDocId} onClose={() => setPreviewDocId(null)} />
      )}

      {error && <p className="text-[#E24B4A]">{error}</p>}

      {warnings.length > 0 && (
        <div className="text-[11px] text-[#9B6B1F] bg-[#FBF3E4] border border-[#EAD9B0] rounded-md p-2 space-y-1">
          {warnings.map((w, i) => <p key={i}>{w}</p>)}
        </div>
      )}

      <div className="space-y-1.5">
        <button
          onClick={() => handleGenerate('itinerary')}
          disabled={generating !== null}
          className="w-full text-[11px] border border-[#E5E4E0] rounded-md px-3 py-2 hover:bg-[#F5F4F1] disabled:opacity-50"
        >
          {generating === 'itinerary' ? 'Generating…' : 'Generate itinerary'}
        </button>
        <button
          onClick={() => handleGenerate('rate_sheet')}
          disabled={generating !== null}
          className="w-full text-[11px] border border-[#E5E4E0] rounded-md px-3 py-2 hover:bg-[#F5F4F1] disabled:opacity-50"
        >
          {generating === 'rate_sheet' ? 'Generating…' : 'Generate rate sheet'}
        </button>
      </div>
    </div>
  )
}

export function TripSidebar({ tripId, refreshKey }: { tripId: string | null; refreshKey: number }) {
  const [data, setData]       = useState<SidebarData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [tab, setTab]         = useState<Tab>('glance')

  const fetchData = useCallback(() => {
    if (!tripId) {
      setData(null)
      return
    }
    setLoading(true)
    setError(null)
    fetch(`/api/studio/trip-builder/trips/${tripId}`)
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Failed to load trip')
        setData(json)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [tripId])

  useEffect(() => {
    fetchData()
  }, [fetchData, refreshKey])

  if (!tripId) {
    return (
      <div className="flex items-center justify-center h-full text-[12px] text-[#9B9A97] px-4 text-center">
        Start a trip to see it here.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex border-b border-[#E5E4E0] shrink-0">
        {([['glance', 'At a glance'], ['rates', 'Rates'], ['documents', 'Documents']] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={[
              'flex-1 text-[11px] px-2 py-2.5 border-b-2 -mb-px',
              tab === key ? 'border-[#0F0F0D] text-[#0F0F0D] font-medium' : 'border-transparent text-[#9B9A97] hover:text-[#6B6A67]',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading && <p className="text-[12px] text-[#9B9A97]">Loading…</p>}
        {error && <p className="text-[12px] text-[#E24B4A]">{error}</p>}
        {data && !loading && (
          <>
            {tab === 'glance' && <AtAGlanceTab data={data} />}
            {tab === 'rates' && <RatesTab tripId={tripId} data={data} onRemoved={fetchData} />}
            {tab === 'documents' && <DocumentsTab tripId={tripId} data={data} onGenerated={fetchData} />}
          </>
        )}
      </div>
    </div>
  )
}
