'use client'

import { useState, useEffect, useCallback } from 'react'
import type { ClientRecord, ClientProfile } from '@/lib/studio/types'
import { ClientListItem } from '@/components/studio/clients/ClientListItem'
import { ClientProfile as ClientProfileComponent } from '@/components/studio/clients/ClientProfile'

type SortOption  = 'name_asc' | 'name_desc' | 'last_booking' | 'spend_desc' | 'date_added'
type FilterOption = 'all' | 'vip' | 'vvip' | 'has_family' | 'no_contact'

export default function ClientsPage() {
  const [clients, setClients]           = useState<ClientRecord[]>([])
  const [selectedId, setSelectedId]     = useState<string | null>(null)
  const [profile, setProfile]           = useState<ClientProfile | null>(null)
  const [loading, setLoading]           = useState(false)
  const [profileLoading, setProfileLoading] = useState(false)
  const [search, setSearch]             = useState('')
  const [sort, setSort]                 = useState<SortOption>('name_asc')
  const [filter, setFilter]             = useState<FilterOption>('all')
  const [userEmail, setUserEmail]       = useState('')

  // Load user email
  useEffect(() => {
    fetch('/api/studio/home')
      .then(r => r.json())
      .then(d => setUserEmail(d.userEmail ?? ''))
      .catch(() => {})
  }, [])

  const loadClients = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ q: search, sort, filter })
      const res = await fetch(`/api/studio/clients?${params}`)
      const { clients: data } = await res.json()
      setClients(data ?? [])
    } finally {
      setLoading(false)
    }
  }, [search, sort, filter])

  useEffect(() => {
    const timer = setTimeout(loadClients, 300)
    return () => clearTimeout(timer)
  }, [loadClients])

  const loadProfile = useCallback(async (id: string) => {
    setProfileLoading(true)
    setSelectedId(id)
    try {
      const res = await fetch(`/api/studio/clients/${id}`)
      const { client } = await res.json()
      setProfile(client)
    } finally {
      setProfileLoading(false)
    }
  }, [])

  const filters: Array<{ key: FilterOption; label: string }> = [
    { key: 'all',        label: 'All' },
    { key: 'vip',        label: 'VIP' },
    { key: 'vvip',       label: 'VVIP' },
    { key: 'no_contact', label: 'No contact' },
  ]

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — search + list */}
      <div className="w-80 shrink-0 border-r border-[#E5E4E0] flex flex-col bg-white">
        {/* Search */}
        <div className="p-3 border-b border-[#E5E4E0]">
          <input
            type="text"
            placeholder="Search clients…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full text-[12px] bg-[#F5F4F1] border-none rounded-md px-3 py-2 focus:outline-none"
          />
        </div>

        {/* Sort + filter */}
        <div className="px-3 py-2 border-b border-[#E5E4E0] flex items-center gap-2">
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortOption)}
            className="text-[11px] border border-[#E5E4E0] rounded px-2 py-1 focus:outline-none flex-1"
          >
            <option value="name_asc">Name A–Z</option>
            <option value="name_desc">Name Z–A</option>
            <option value="date_added">Date added</option>
          </select>
        </div>

        {/* Filter chips */}
        <div className="px-3 py-2 border-b border-[#E5E4E0] flex gap-1.5 flex-wrap">
          {filters.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-[10px] px-2 py-1 rounded-full border transition-colors ${
                filter === f.key
                  ? 'bg-[#0F0F0D] text-white border-[#0F0F0D]'
                  : 'border-[#E5E4E0] text-[#6B6A67] hover:bg-[#F5F4F1]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Client list */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <p className="text-[12px] text-[#9B9A97] text-center py-8">Loading…</p>
          )}
          {!loading && clients.length === 0 && (
            <p className="text-[12px] text-[#9B9A97] text-center py-8">No clients found.</p>
          )}
          {!loading && clients.map(c => (
            <ClientListItem
              key={c.id}
              client={c}
              isSelected={c.id === selectedId}
              onClick={() => loadProfile(c.id)}
            />
          ))}
        </div>
      </div>

      {/* Right panel — profile */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {!selectedId && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[13px] text-[#9B9A97]">Select a client to view their profile.</p>
          </div>
        )}
        {selectedId && profileLoading && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[13px] text-[#9B9A97]">Loading profile…</p>
          </div>
        )}
        {selectedId && !profileLoading && profile && (
          <ClientProfileComponent
            profile={profile}
            userEmail={userEmail}
            onNavigateToClient={(id) => loadProfile(id)}
            onRefresh={() => loadProfile(selectedId)}
          />
        )}
      </div>
    </div>
  )
}
