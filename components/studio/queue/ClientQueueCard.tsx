'use client'

import { useState, useEffect } from 'react'
import type { QueueClient, ClientRecord } from '@/lib/studio/types'

interface Props {
  client: QueueClient
  onApprove: (id: string) => Promise<void>
  onReject: (id: string) => Promise<void>
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

function FieldRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-[10px] text-[#9B9A97] uppercase tracking-[0.04em] mb-[3px]">{label}</p>
      <p className={`text-[12px] ${value ? 'text-[#0F0F0D]' : 'text-[#BA7517] italic'}`}>
        {value ?? 'Not captured'}
      </p>
    </div>
  )
}

// ----------------------------------------------------------------
// MergePanel
// ----------------------------------------------------------------

interface MergePanelProps {
  incoming: QueueClient
  similarClientId: string
  similarClientName: string
  onMerged: () => void
  onCancel: () => void
}

function MergePanel({ incoming, similarClientId, onMerged, onCancel }: MergePanelProps) {
  const [existing, setExisting] = useState<ClientRecord | null>(null)
  const [loading, setLoading]   = useState(true)
  const [merging, setMerging]   = useState(false)
  const [winner, setWinner]     = useState<'existing' | 'incoming'>('existing')

  useEffect(() => {
    fetch(`/api/studio/clients/${similarClientId}`)
      .then(r => r.json())
      .then(d => { setExisting(d.client); setLoading(false) })
      .catch(() => setLoading(false))
  }, [similarClientId])

  async function handleMerge() {
    setMerging(true)
    try {
      const winnerId = winner === 'existing' ? similarClientId : incoming.id
      const loserId  = winner === 'existing' ? incoming.id : similarClientId
      const res = await fetch('/api/studio/clients/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ winnerId, loserId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Merge failed')
      onMerged()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setMerging(false)
    }
  }

  if (loading) return (
    <div className="mt-3 pt-3 border-t border-[#FAC775] text-[11px] text-[#633806]">
      Loading existing client…
    </div>
  )

  if (!existing) return (
    <div className="mt-3 pt-3 border-t border-[#FAC775] text-[11px] text-[#E24B4A]">
      Could not load existing client.
    </div>
  )

  const fields: Array<{ key: keyof ClientRecord; label: string }> = [
    { key: 'full_name',         label: 'Full name' },
    { key: 'email',             label: 'Email' },
    { key: 'phone',             label: 'Phone' },
    { key: 'whatsapp',          label: 'WhatsApp' },
    { key: 'nationality',       label: 'Nationality' },
    { key: 'city_of_residence', label: 'City' },
    { key: 'vip_level',         label: 'VIP level' },
  ]

  return (
    <div className="mt-3 pt-3 border-t border-[#FAC775]">
      <p className="text-[11px] font-medium text-[#633806] mb-2">
        Choose which record to keep — the other will be deactivated and its bookings transferred.
      </p>

      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* Existing */}
        <div
          onClick={() => setWinner('existing')}
          className={`bg-white rounded-md p-3 border-2 cursor-pointer ${
            winner === 'existing' ? 'border-[#633806]' : 'border-[#E5E4E0]'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
              winner === 'existing' ? 'border-[#633806] bg-[#633806]' : 'border-[#9B9A97]'
            }`}>
              {winner === 'existing' && (
                <div className="w-1.5 h-1.5 rounded-full bg-white" />
              )}
            </div>
            <p className="text-[11px] font-medium text-[#0F0F0D]">Existing — keep this</p>
          </div>
          {fields.map(({ key, label }) => (
            <div key={key} className="mb-1.5">
              <p className="text-[9px] text-[#9B9A97] uppercase tracking-wider">{label}</p>
              <p className="text-[11px] text-[#0F0F0D]">{String(existing[key] ?? '—')}</p>
            </div>
          ))}
        </div>

        {/* Incoming */}
        <div
          onClick={() => setWinner('incoming')}
          className={`bg-white rounded-md p-3 border-2 cursor-pointer ${
            winner === 'incoming' ? 'border-[#633806]' : 'border-[#E5E4E0]'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
              winner === 'incoming' ? 'border-[#633806] bg-[#633806]' : 'border-[#9B9A97]'
            }`}>
              {winner === 'incoming' && (
                <div className="w-1.5 h-1.5 rounded-full bg-white" />
              )}
            </div>
            <p className="text-[11px] font-medium text-[#0F0F0D]">New record — keep this</p>
          </div>
          {fields.map(({ key, label }) => (
            <div key={key} className="mb-1.5">
              <p className="text-[9px] text-[#9B9A97] uppercase tracking-wider">{label}</p>
              <p className="text-[11px] text-[#0F0F0D]">{String(incoming[key] ?? '—')}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="text-[11px] text-[#633806] border border-[#FAC775] px-3 py-1.5 rounded-md hover:bg-[#FAC775] mr-auto"
        >
          Cancel
        </button>
        <button
          onClick={handleMerge}
          disabled={merging}
          className="text-[11px] bg-[#633806] text-white px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-50"
        >
          {merging ? 'Merging…' : 'Confirm merge'}
        </button>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// RelationshipLinkPanel
// ----------------------------------------------------------------

interface ClientSearchResult {
  id: string
  full_name: string
  phone: string | null
  email: string | null
}

const RELATIONSHIP_SUGGESTIONS = ['Mother', 'Father', 'Spouse', 'Guardian', 'Sibling', 'Assistant']

interface RelationshipLinkPanelProps {
  clientId: string
  onLinked: () => void
  onCancel: () => void
}

function RelationshipLinkPanel({ clientId, onLinked, onCancel }: RelationshipLinkPanelProps) {
  const [query, setQuery]           = useState('')
  const [results, setResults]       = useState<ClientSearchResult[]>([])
  const [searching, setSearching]   = useState(false)
  const [selected, setSelected]     = useState<ClientSearchResult | null>(null)
  const [relationshipType, setRelationshipType] = useState('')
  const [linking, setLinking]       = useState(false)

  useEffect(() => {
    if (!query.trim() || selected) { setResults([]); return }
    setSearching(true)
    const handle = setTimeout(() => {
      fetch(`/api/studio/clients/search?q=${encodeURIComponent(query)}&exclude=${clientId}`)
        .then(r => r.json())
        .then(d => setResults(d.clients ?? []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(handle)
  }, [query, selected, clientId])

  async function handleLink() {
    if (!selected || !relationshipType.trim()) return
    setLinking(true)
    try {
      const res = await fetch(`/api/studio/queue/clients/${clientId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:            'link_relationship',
          relatedClientId:   selected.id,
          relationshipType:  relationshipType.trim(),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `Link failed (${res.status})`)
      }
      onLinked()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setLinking(false)
    }
  }

  return (
    <div className="mt-3 mb-3 bg-[#E6F1FB] border border-[#B5D4F4] rounded-md p-3">
      <p className="text-[11px] font-medium text-[#0C447C] mb-2">
        Link to a contactable client instead of adding phone/email
      </p>

      {selected ? (
        <div className="flex items-center justify-between bg-white rounded-md px-2.5 py-1.5 mb-2 border border-[#B5D4F4]">
          <span className="text-[12px] text-[#0F0F0D]">{selected.full_name}</span>
          <button
            onClick={() => { setSelected(null); setQuery('') }}
            className="text-[10px] text-[#0C447C] hover:underline"
          >
            Change
          </button>
        </div>
      ) : (
        <div className="mb-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search clients by name…"
            className="w-full text-[12px] text-[#0F0F0D] border border-[#B5D4F4] rounded px-2 py-1.5 bg-white focus:outline-none focus:border-[#0C447C]"
          />
          {query.trim() && (
            <div className="mt-1 bg-white border border-[#B5D4F4] rounded-md max-h-40 overflow-y-auto">
              {searching ? (
                <p className="text-[11px] text-[#6B6A67] px-2 py-1.5">Searching…</p>
              ) : results.length ? (
                results.map(r => (
                  <button
                    key={r.id}
                    onClick={() => { setSelected(r); setResults([]) }}
                    className="w-full text-left px-2 py-1.5 hover:bg-[#F5F4F1] border-b border-[#F0EFEC] last:border-0"
                  >
                    <p className="text-[12px] text-[#0F0F0D]">{r.full_name}</p>
                    <p className="text-[10px] text-[#9B9A97]">{r.phone || r.email || 'No contact info'}</p>
                  </button>
                ))
              ) : (
                <p className="text-[11px] text-[#6B6A67] px-2 py-1.5">No matches</p>
              )}
            </div>
          )}
        </div>
      )}

      <input
        type="text"
        list="relationship-suggestions"
        value={relationshipType}
        onChange={e => setRelationshipType(e.target.value)}
        placeholder="Relationship (e.g. Mother)"
        className="w-full text-[12px] text-[#0F0F0D] border border-[#B5D4F4] rounded px-2 py-1.5 bg-white focus:outline-none focus:border-[#0C447C]"
      />
      <datalist id="relationship-suggestions">
        {RELATIONSHIP_SUGGESTIONS.map(s => <option key={s} value={s} />)}
      </datalist>

      <div className="flex gap-2 mt-2">
        <button
          onClick={onCancel}
          className="text-[11px] text-[#0C447C] border border-[#B5D4F4] px-3 py-1.5 rounded-md hover:bg-[#B5D4F4] mr-auto"
        >
          Cancel
        </button>
        <button
          onClick={handleLink}
          disabled={!selected || !relationshipType.trim() || linking}
          className="text-[11px] bg-[#0C447C] text-white px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-50"
        >
          {linking ? 'Linking…' : 'Link'}
        </button>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// ClientQueueCard
// ----------------------------------------------------------------

export function ClientQueueCard({ client, onApprove, onReject, onRefresh }: Props) {
  const [loading, setLoading]   = useState<'approve' | 'reject' | null>(null)
  const [editing, setEditing]   = useState(false)
  const [saving, setSaving]     = useState(false)
  const [mergeDismissed, setMergeDismissed] = useState(false)
  const [showMergePanel, setShowMergePanel] = useState(false)
  const [showRelationshipPanel, setShowRelationshipPanel] = useState(false)
  const [editFields, setEditFields] = useState({
    full_name:         client.full_name ?? '',
    email:             client.email ?? '',
    phone:             client.phone ?? '',
    whatsapp:          client.whatsapp ?? '',
    nationality:       client.nationality ?? '',
    city_of_residence: client.city_of_residence ?? '',
    vip_level:         client.vip_level ?? '',
    general_notes:     client.general_notes ?? '',
  })

  const canApprove = client.missing_required.length === 0
  const initials = client.full_name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(n => n[0].toUpperCase())
    .join('')

  async function handleApprove() {
    setLoading('approve')
    try {
      await onApprove(client.id)
      onRefresh()
    } finally {
      setLoading(null)
    }
  }

  async function handleReject() {
    setLoading('reject')
    try {
      await onReject(client.id)
      onRefresh()
    } finally {
      setLoading(null)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch(`/api/studio/queue/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editFields),
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
    <div className={`bg-white border rounded-lg p-4 mb-3 ${
      client.duplicate_warning && !mergeDismissed ? 'border-[#FAC775]' : 'border-[#E5E4E0]'
    }`}>

      {/* Duplicate warning */}
      {client.duplicate_warning && !mergeDismissed && (
        <div className="bg-[#FAEEDA] border border-[#FAC775] rounded-md px-3 py-2 text-[11px] text-[#633806] mb-3">
          <div className="flex items-start gap-2">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-px">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <path d="M12 9v4" /><path d="M12 17h.01" />
            </svg>
            <div className="flex-1">
              <span>
                {client.duplicate_warning.message} —{' '}
                <span className="font-medium">{client.duplicate_warning.similar_client_name}</span>
                {' '}({Math.round(client.duplicate_warning.similarity_score * 100)}% match)
              </span>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => setShowMergePanel(true)}
                  className="bg-[#633806] text-white text-[10px] px-2 py-1 rounded hover:opacity-90"
                >
                  Merge with existing
                </button>
                <button
                  onClick={() => setMergeDismissed(true)}
                  className="text-[#633806] text-[10px] px-2 py-1 rounded border border-[#FAC775] hover:bg-[#FAC775]"
                >
                  Keep as new
                </button>
              </div>
            </div>
          </div>

          {/* Merge panel */}
          {showMergePanel && (
            <MergePanel
              incoming={client}
              similarClientId={client.duplicate_warning.similar_client_id}
              similarClientName={client.duplicate_warning.similar_client_name}
              onMerged={() => {
                setShowMergePanel(false)
                onRefresh()
              }}
              onCancel={() => setShowMergePanel(false)}
            />
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-[#F5F4F1] flex items-center justify-center text-[12px] font-medium text-[#0F0F0D] shrink-0">
            {initials}
          </div>
          <div>
            <p className="text-[13px] font-medium text-[#0F0F0D]">{client.full_name}</p>
            <p className="text-[11px] text-[#9B9A97] mt-0.5">
              Added {timeAgo(client.created_at)}
              {client.booking_count > 0 && (
                <span> · {client.booking_count} booking{client.booking_count !== 1 ? 's' : ''} linked</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {client.vip_level && client.vip_level !== 'standard' && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
              client.vip_level === 'vvip'
                ? 'bg-[#FBEAF0] text-[#72243E]'
                : 'bg-[#FAEEDA] text-[#633806]'
            }`}>
              {client.vip_level.toUpperCase()}
            </span>
          )}
          <span className="text-[10px] bg-[#FAEEDA] text-[#633806] px-2 py-0.5 rounded-full font-medium">
            Pending
          </span>
        </div>
      </div>

      {/* Fields */}
      {editing ? (
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            { key: 'full_name',         label: 'Full name' },
            { key: 'email',             label: 'Email' },
            { key: 'phone',             label: 'Phone' },
            { key: 'whatsapp',          label: 'WhatsApp' },
            { key: 'nationality',       label: 'Nationality' },
            { key: 'city_of_residence', label: 'City' },
            { key: 'vip_level',         label: 'VIP level' },
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
              value={editFields.general_notes}
              onChange={e => setEditFields(f => ({ ...f, general_notes: e.target.value }))}
              rows={2}
              className="w-full text-[12px] text-[#0F0F0D] border border-[#E5E4E0] rounded px-2 py-1 focus:outline-none focus:border-[#9B9A97] resize-none"
            />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <FieldRow label="Email"       value={client.email} />
          <FieldRow label="Phone"       value={client.phone} />
          <FieldRow label="WhatsApp"    value={client.whatsapp} />
          <FieldRow label="Nationality" value={client.nationality} />
          <FieldRow label="City"        value={client.city_of_residence} />
          <FieldRow label="VIP level"   value={client.vip_level} />
          {client.general_notes && (
            <div className="col-span-3">
              <p className="text-[10px] text-[#9B9A97] uppercase tracking-[0.04em] mb-1">Notes</p>
              <p className="text-[11px] text-[#6B6A67] leading-relaxed">{client.general_notes}</p>
            </div>
          )}
        </div>
      )}

      {/* Linked relationship (waives phone/email requirement) */}
      {client.relationship_via && (
        <div className="text-[11px] text-[#0C447C] mb-3">
          Reachable via <span className="font-medium">{client.relationship_via.client_name}</span>
          {' '}({client.relationship_via.relationship_type})
        </div>
      )}

      {/* Missing required warning */}
      {client.missing_required.length > 0 && (
        <div className="text-[11px] text-[#E24B4A] mb-3">
          Required before approving: {client.missing_required.map(f => f.label).join(', ')}
        </div>
      )}

      {/* Link-to-relative panel */}
      {showRelationshipPanel && !client.relationship_via && (
        <RelationshipLinkPanel
          clientId={client.id}
          onLinked={() => { setShowRelationshipPanel(false); onRefresh() }}
          onCancel={() => setShowRelationshipPanel(false)}
        />
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
            {!client.relationship_via && client.missing_required.some(f => f.field === 'phone') && (
              <button
                onClick={() => setShowRelationshipPanel(v => !v)}
                className="text-[11px] text-[#0C447C] border border-[#B5D4F4] px-3 py-1.5 rounded-md hover:bg-[#E6F1FB]"
              >
                {showRelationshipPanel ? 'Cancel link' : 'Link relationship'}
              </button>
            )}
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
    </div>
  )
}
