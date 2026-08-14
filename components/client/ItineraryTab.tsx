export interface Leg {
  id:               string
  destination:      string
  check_in:         string | null
  check_out:        string | null
  itinerary_status: string
}

export interface ItineraryDayItem {
  type: 'confirmed' | 'hotel' | 'dining' | 'alt' | 'casual' | 'note'
  text: string
}

export interface ItineraryDay {
  id:      string
  leg_id:  string
  day_num: number
  date:    string | null
  title:   string | null
  items:   ItineraryDayItem[]
}

function formatDate(d: string | null): string | null {
  if (!d) return null
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function ItemLine({ item }: { item: ItineraryDayItem }) {
  if (item.type === 'hotel' || item.type === 'dining') {
    return (
      <p className="text-[12.5px] text-[#0F0F0D] bg-[#F5F4F1] rounded px-2 py-1.5 font-medium">
        {item.text}
      </p>
    )
  }
  if (item.type === 'alt' || item.type === 'casual') {
    return <p className="text-[11.5px] text-[#9B9A97]">{item.text}</p>
  }
  return <p className="text-[12.5px] text-[#3A3A38]">{item.text}</p>
}

function DayCard({ day }: { day: ItineraryDay }) {
  const date = formatDate(day.date)
  return (
    <div className="pt-3 border-t border-[#E5E4E0] first:pt-0 first:border-0">
      <p className="text-[11px] text-[#9B9A97] mb-0.5">Day {day.day_num}{date ? ` · ${date}` : ''}</p>
      {day.title && <p className="text-[13.5px] font-medium text-[#0F0F0D] mb-1.5">{day.title}</p>}
      <div className="space-y-1">
        {day.items.map((item, i) => <ItemLine key={i} item={item} />)}
      </div>
    </div>
  )
}

export function ItineraryTab({ legs, days }: { legs: Leg[]; days: ItineraryDay[] }) {
  if (legs.length === 0) {
    return <p className="text-[12.5px] text-[#9B9A97]">No itinerary yet — it fills in as the trip takes shape.</p>
  }

  return (
    <div className="space-y-6">
      {legs.map(leg => {
        const legDays = days.filter(d => d.leg_id === leg.id).sort((a, b) => a.day_num - b.day_num)
        const dates = [formatDate(leg.check_in), formatDate(leg.check_out)].filter(Boolean).join(' – ')
        return (
          <div key={leg.id}>
            <p className="text-[11px] font-semibold text-[#9B9A97] uppercase tracking-wide mb-2">
              {leg.destination}{dates ? ` · ${dates}` : ''}
            </p>
            {legDays.length === 0 ? (
              <p className="text-[12px] text-[#9B9A97]">Being planned</p>
            ) : (
              <div className="space-y-3">
                {legDays.map(day => <DayCard key={day.id} day={day} />)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
