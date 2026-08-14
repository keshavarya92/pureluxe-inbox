'use client'

import { useState } from 'react'

export interface RateOption {
  id:                      string
  name:                    string
  subtitle:                string | null
  currency:                string | null
  total:                   number
  breakdown:               Array<{ label: string; amount: number }>
  selected:                boolean
  checkIn:                 string | null
  checkOut:                string | null
  roomSize:                string | null
  roomFeatures:            string[]
  inclusions:              string[]
  cancellationPolicy:      string | null
  paymentPolicy:           string | null
  loyaltyHotelEligible:    boolean | null
  loyaltyPureluxeEligible: boolean | null
}

export interface PropertyGroup {
  property_name: string
  leg_id:        string | null
  options:       RateOption[]
}

function formatMoney(currency: string | null, amount: number): string {
  return `${currency === 'USD' || !currency ? '$' : currency + ' '}${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

function formatDate(d: string | null): string | null {
  if (!d) return null
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10.5px] text-[#9B9A97]">{label}</p>
      <p className="text-[12px] text-[#3A3A38] mt-0.5">{value}</p>
    </div>
  )
}

function LoyaltyBadge({ label, eligible }: { label: string; eligible: boolean | null }) {
  if (eligible === null) return null
  return (
    <span
      className={[
        'inline-flex items-center gap-1 text-[10.5px] rounded px-1.5 py-0.5',
        eligible ? 'bg-[#E9F5EC] text-[#1F7A3D]' : 'bg-[#F5F4F1] text-[#9B9A97]',
      ].join(' ')}
    >
      {label} {eligible ? '✓' : '—'}
    </span>
  )
}

interface Props {
  groups:       PropertyGroup[]
  onSetLeaning: (optionId: string) => void
}

export function RatesTab({ groups, onSetLeaning }: Props) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  function toggleExpanded(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (groups.length === 0) {
    return <p className="text-[12.5px] text-[#9B9A97]">No rates yet — options appear here as properties come up in chat.</p>
  }

  return (
    <div className="space-y-5">
      {groups.map((group, gi) => (
        <div key={`${group.leg_id ?? 'trip'}-${group.property_name}-${gi}`}>
          <p className="text-[11px] font-semibold text-[#9B9A97] uppercase tracking-wide mb-2">{group.property_name}</p>
          <div className="space-y-2">
            {group.options.map(option => {
              const expanded = expandedIds.has(option.id)
              const dateRange = [formatDate(option.checkIn), formatDate(option.checkOut)].filter(Boolean).join(' – ')
              return (
                <div
                  key={option.id}
                  className={['border rounded-lg px-3.5 py-3', option.selected ? 'border-[#0F0F0D]' : 'border-[#E5E4E0]'].join(' ')}
                >
                  <button onClick={() => toggleExpanded(option.id)} className="w-full flex items-start justify-between gap-2 text-left">
                    <div>
                      <p className="text-[13.5px] font-medium text-[#0F0F0D]">{option.name}</p>
                      <p className="text-[11.5px] text-[#9B9A97] mt-0.5">
                        {[option.subtitle, dateRange, option.roomSize].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <p className="text-[13.5px] font-medium text-[#0F0F0D] whitespace-nowrap">
                      {formatMoney(option.currency, option.total)}
                    </p>
                  </button>

                  {option.selected && (
                    <span className="inline-block text-[10.5px] font-medium text-white bg-[#0F0F0D] rounded px-1.5 py-0.5 mt-2">
                      Leaning towards this
                    </span>
                  )}

                  {expanded && (
                    <div className="mt-3 pt-3 border-t border-[#F0EFE9] space-y-3">
                      <div className="space-y-1.5">
                        {option.breakdown.map((line, i) => (
                          <div key={i} className="flex items-center justify-between text-[12px] text-[#6B6A67]">
                            <span>{line.label}</span>
                            <span>{formatMoney(option.currency, line.amount)}</span>
                          </div>
                        ))}
                      </div>

                      {option.roomFeatures.length > 0 && (
                        <DetailRow label="Room features" value={option.roomFeatures.join(', ')} />
                      )}
                      {option.inclusions.length > 0 && (
                        <DetailRow label="Inclusions" value={option.inclusions.join(', ')} />
                      )}
                      {option.cancellationPolicy && (
                        <DetailRow label="Cancellation policy" value={option.cancellationPolicy} />
                      )}
                      {option.paymentPolicy && (
                        <DetailRow label="Payment policy" value={option.paymentPolicy} />
                      )}

                      {(option.loyaltyHotelEligible !== null || option.loyaltyPureluxeEligible !== null) && (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <LoyaltyBadge label="Hotel loyalty points" eligible={option.loyaltyHotelEligible} />
                          <LoyaltyBadge label="PureLuxe loyalty points" eligible={option.loyaltyPureluxeEligible} />
                        </div>
                      )}
                    </div>
                  )}

                  <div className="mt-2.5 pt-2 border-t border-[#F0EFE9]">
                    <button
                      onClick={() => onSetLeaning(option.id)}
                      disabled={option.selected}
                      className="text-[11px] text-[#6B6A67] hover:text-[#0F0F0D] disabled:opacity-40 disabled:cursor-default"
                    >
                      {option.selected ? 'Leaning towards this' : 'Mark as leaning towards this'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
