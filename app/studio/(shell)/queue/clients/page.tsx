'use client'

import { useState, useEffect, useCallback } from 'react'
import type { QueueClient } from '@/lib/studio/types'
import { ClientQueueCard } from '@/components/studio/queue/ClientQueueCard'

export default function QueueClientsPage() {
  const [clients, setClients]     = useState<QueueClient[]>([])
  const [loading, setLoading]     = useState(true)
  const [userEmail, setUserEmail] = useState('')
  const [error, setError]         = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/studio/queue/clients')
      if (!res.ok) throw new Error(`Failed to load clients (${res.status})`)
      const { clients: data, userEmail: email } = await res.json()
      setClients(data)
      setUserEmail(email)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleAction(action: 'approve' | 'reject', id: string) {
    const res = await fetch(`/api/studio/queue/clients/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (!res.ok) {
      const { error } = await res.json()
      throw new Error(error ?? 'Action failed')
    }
  }

  return (
    <div className="p-5">
      {loading && (
        <div className="text-[13px] text-[#9B9A97] py-10 text-center">Loading clients…</div>
      )}
      {error && (
        <div className="text-[13px] text-[#E24B4A] py-10 text-center">{error}</div>
      )}
      {!loading && !error && clients.length === 0 && (
        <div className="text-[13px] text-[#9B9A97] py-10 text-center">
          No clients pending review.
        </div>
      )}
      {!loading && !error && clients.map(client => (
        <ClientQueueCard
          key={client.id}
          client={client}
          onApprove={async (id) => handleAction('approve', id)}
          onReject={async (id) => handleAction('reject', id)}
          onRefresh={load}
        />
      ))}
    </div>
  )
}
