'use client'

import { useState, useEffect } from 'react'
import { MetricCard } from '@/components/studio/home/MetricCard'
import { DeadlineList } from '@/components/studio/home/DeadlineList'
import { CheckinList } from '@/components/studio/home/CheckinList'
import { PaymentDueList } from '@/components/studio/home/PaymentDueList'
import type { Booking } from '@/lib/studio/types'

interface HomeData {
  checkins:       Booking[]
  checkouts:      Booking[]
  deadlines:      Booking[]
  payments:       Booking[]
  upcoming:       Booking[]
  pendingBookings: number
  pendingClients:  number
}

function greet(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function HomePage() {
  const [data, setData]     = useState<HomeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/studio/home')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [])

  if (loading) {
    return (
      <div className="p-6 text-[13px] text-[#9B9A97]">Loading…</div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-6 text-[13px] text-[#E24B4A]">
        {error ?? 'Failed to load dashboard.'}
      </div>
    )
  }

  const vipCheckins = data.checkins.filter(b => b.vip_flag || b.vvip_flag)
  const totalPending = data.pendingBookings + data.pendingClients

  return (
    <div className="p-6">
      {/* Greeting */}
      <p className="text-[13px] text-[#9B9A97] mb-5">{greet()}</p>

      {/* Metric cards */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <MetricCard
          label="Check-ins today"
          value={data.checkins.length}
          sub={vipCheckins.length > 0 ? `${vipCheckins.length} VIP` : undefined}
        />
        <MetricCard
          label="Check-outs today"
          value={data.checkouts.length}
          sub={data.checkouts.map(b => b.client_name).filter(Boolean).slice(0, 2).join(', ') || undefined}
        />
        <MetricCard
          label="Queue pending"
          value={totalPending}
          sub={`${data.pendingBookings} booking${data.pendingBookings !== 1 ? 's' : ''}, ${data.pendingClients} client${data.pendingClients !== 1 ? 's' : ''}`}
          alert={totalPending > 0}
        />
        <MetricCard
          label="Deadlines this week"
          value={data.deadlines.length}
          sub={data.deadlines.filter(b => b.cancellation_deadline === new Date().toISOString().slice(0, 10)).length > 0
            ? `${data.deadlines.filter(b => b.cancellation_deadline === new Date().toISOString().slice(0, 10)).length} today`
            : undefined}
          warning={data.deadlines.length > 0}
          alert={data.deadlines.some(b => b.cancellation_deadline === new Date().toISOString().slice(0, 10))}
        />
      </div>

      {/* Two column layout */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        {/* Cancellation deadlines */}
        <div className="bg-white border border-[#E5E4E0] rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[12px] font-medium text-[#0F0F0D]">Cancellation deadlines</p>
            <p className="text-[11px] text-[#9B9A97]">Next 7 days</p>
          </div>
          <DeadlineList deadlines={data.deadlines} />
        </div>

        {/* Today's check-ins */}
        <div className="bg-white border border-[#E5E4E0] rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[12px] font-medium text-[#0F0F0D]">
              {data.checkins.length > 0 ? "Today's check-ins" : "Upcoming check-ins"}
            </p>
            <p className="text-[11px] text-[#9B9A97]">
              {data.checkins.length > 0 ? 'Today' : 'Next 7 days'}
            </p>
          </div>
          <CheckinList
            checkins={data.checkins.length > 0 ? data.checkins : data.upcoming}
            emptyMessage="No check-ins in the next 7 days."
          />
        </div>
      </div>

      {/* Payments due */}
      <div className="bg-white border border-[#E5E4E0] rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[12px] font-medium text-[#0F0F0D]">Payments due this week</p>
          <p className="text-[11px] text-[#9B9A97]">Check-ins within 7 days</p>
        </div>
        <PaymentDueList payments={data.payments} />
      </div>
    </div>
  )
}
