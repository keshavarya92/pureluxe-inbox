'use client'

import { useState, useEffect, useCallback } from 'react'
import { ItineraryTab, type Leg, type ItineraryDay } from './ItineraryTab'
import { RatesTab, type PropertyGroup } from './RatesTab'

export type RightTab = 'itinerary' | 'rates'

const ChevronLeftIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
)
const ChevronRightIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

interface TripView {
  legs:           Leg[]
  itinerary_days: ItineraryDay[]
  rate_groups:    PropertyGroup[]
}

interface Props {
  tripId:           string
  collapsed:        boolean
  tab:              RightTab
  refreshKey:       number
  onToggleCollapse: () => void
  onTabChange:      (tab: RightTab) => void
  onActivity:       () => void
}

export function RightSidebar({ tripId, collapsed, tab, refreshKey, onToggleCollapse, onTabChange, onActivity }: Props) {
  const [data, setData]       = useState<TripView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const fetchData = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/client/trips/${tripId}`)
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Failed to load trip')
        setData(json)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [tripId])

  useEffect(() => { fetchData() }, [fetchData, refreshKey])

  async function handleSetLeaning(optionId: string) {
    try {
      const res = await fetch(`/api/client/trips/${tripId}/line-items/${optionId}/lean`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to update')
      fetchData()
      onActivity()
    } catch (err: any) {
      setError(err.message)
    }
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center h-full py-3">
        <button onClick={onToggleCollapse} title="Expand itinerary & rates" className="w-8 h-8 flex items-center justify-center rounded-md text-[#6B6A67] hover:bg-[#F5F4F1]">
          <ChevronLeftIcon />
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center border-b border-[#E5E4E0] shrink-0">
        {([['itinerary', 'Itinerary'], ['rates', 'Rates']] as [RightTab, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => onTabChange(key)}
            className={[
              'flex-1 text-[12.5px] px-2 py-3 border-b-2 -mb-px',
              tab === key ? 'border-[#0F0F0D] text-[#0F0F0D] font-medium' : 'border-transparent text-[#9B9A97] hover:text-[#6B6A67]',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
        <button onClick={onToggleCollapse} title="Collapse" className="w-9 h-9 flex items-center justify-center text-[#9B9A97] hover:bg-[#F5F4F1] hover:text-[#6B6A67] shrink-0">
          <ChevronRightIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading && <p className="text-[12.5px] text-[#9B9A97]">Loading…</p>}
        {error && <p className="text-[12.5px] text-[#E24B4A]">{error}</p>}
        {data && !loading && (
          tab === 'itinerary'
            ? <ItineraryTab legs={data.legs} days={data.itinerary_days} />
            : <RatesTab groups={data.rate_groups} onSetLeaning={handleSetLeaning} />
        )}
      </div>
    </div>
  )
}
