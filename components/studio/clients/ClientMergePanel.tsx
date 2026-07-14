'use client'

import { useState, useEffect } from 'react'
import type { ClientProfile, ClientRecord } from '@/lib/studio/types'

interface Props {
  client: ClientProfile
  userEmail: string
  onMerged: () => void
  onCancel: () => void
}

export function ClientMergePanel({ client, userEmail, onMerged, onCancel }: Props) {
  const [searchQuery, setSearchQuery]   = useState('')
  const [results, setResults]           = useState<ClientRecord[]>([])
  const [selected, setSelected]         = useState<ClientRecord | null>(null)
  const [winner, setWinner]             = useState<'current' | 'other'>('current')
  const [merging, setMerging]           = useState(false)

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (searchQuery.length < 2) { setResults([]); return }
      const res = await fetch(`/api/studio/clients?q=${encodeURIComponent(searchQuery)}`)
      const { clients } = await res.json()
      setResults((clients as ClientRecord[]).filter(c => c.id !== client.id).slice(0, 8))
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, client.id])

  async function handleMerge() {
    if (!selected) return
    setMerging(true)
    try {
      const winnerId = winner === 'current' ? client.id : selected.id
      const loserId  = winner === 'current' ? selected.id : client.id
      const res = await fetch('/api/studio/clients/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ winnerId, loserId }),
      })
      if (!res.ok) throw new Error('Merge failed')
      onMerged()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setMerging(false)
    }
  }

  const FIELDS: Array<{ key: keyof ClientRecord; label: string }> = [
    { key: 'full_name',         label: 'Full name' },
    { key: 'email',             label: 'Email' },
    { key: 'phone',             label: 'Phone' },
    { key: 'whatsapp',          label: 'WhatsApp' },
    { key: 'nationality',       label: 'Nationality' },
    { key: 'city_of_residence', label: 'City' },
    { key: 'vip_level',         label: 'VIP level' },
  ]

  return (
    <div className="p-5">
      <p className="text-[12px] font-medium text-[#0F0F0D] mb-3">
        Merge with another client
      </p>

      {!selected ? (
        <>
          <p className="text-[11px] text-[#9B9A97] mb-3">
            Search for the duplicate client record to merge with.
          </p>
          <input
            type="text"
            placeholder="Search by name…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full text-[12px] border border-[#E5E4E0] rounded px-3 py-2 mb-3 focus:outline-none focus:border-[#9B9A97]"
          />
          {results.map(r => (
            <button
              key={r.id}
              onClick={() => setSelected(r)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded hover:bg-[#F5F4F1] text-left mb-1"
            >
              <p className="text-[12px] text-[#0F0F0D]">{r.full_name}</p>
              <p className="text-[11px] text-[#9B9A97] ml-auto">{r.email ?? r.phone ?? ''}</p>
            </button>
          ))}
          <div className="flex gap-2 mt-4 pt-3 border-t border-[#E5E4E0]">
            <button onClick={onCancel} className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1]">
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[11px] text-[#9B9A97] mb-3">
            Choose which record to keep. The other will be deleted and its bookings transferred.
          </p>
          <div className="grid grid-cols-2 gap-3 mb-4">
            {[
              { label: 'Current', record: client as ClientRecord, key: 'current' as const },
              { label: 'Other',   record: selected,                key: 'other'   as const },
            ].map(({ label, record, key }) => (
              <div
                key={key}
                onClick={() => setWinner(key)}
                className={`rounded-lg p-3 border-2 cursor-pointer ${
                  winner === key ? 'border-[#0F0F0D]' : 'border-[#E5E4E0]'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-3 h-3 rounded-full border-2 ${winner === key ? 'border-[#0F0F0D] bg-[#0F0F0D]' : 'border-[#9B9A97]'}`} />
                  <p className="text-[10px] font-medium text-[#0F0F0D]">{label} — keep this</p>
                </div>
                {FIELDS.map(f => (
                  <div key={String(f.key)} className="mb-1">
                    <p className="text-[9px] text-[#9B9A97] uppercase tracking-wider">{f.label}</p>
                    <p className="text-[11px] text-[#0F0F0D]">{String(record[f.key] ?? '—')}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-3 border-t border-[#E5E4E0]">
            <button
              onClick={() => setSelected(null)}
              className="text-[11px] text-[#6B6A67] border border-[#E5E4E0] px-3 py-1.5 rounded-md hover:bg-[#F5F4F1] mr-auto"
            >
              Back
            </button>
            <button
              onClick={handleMerge}
              disabled={merging}
              className="text-[11px] bg-[#0F0F0D] text-white px-3 py-1.5 rounded-md hover:opacity-90 disabled:opacity-50"
            >
              {merging ? 'Merging…' : 'Confirm merge'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
