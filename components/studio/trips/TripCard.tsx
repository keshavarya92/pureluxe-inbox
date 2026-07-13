import type { TripGroup, Booking } from '@/lib/studio/types'
import { TripLeg } from './TripLeg'

interface Props {
  trip: TripGroup
  onLegClick: (booking: Booking) => void
}

export function TripCard({ trip, onLegClick }: Props) {
  const today = new Date().toISOString().slice(0, 10)
  const hasUrgentDeadline = trip.most_urgent_deadline
    ? trip.most_urgent_deadline <= today
    : false

  return (
    <div className={`bg-white border rounded-lg p-4 mb-3 ${
      hasUrgentDeadline ? 'border-[#F4C0D1]' : 'border-[#E5E4E0]'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-[#0F0F0D]">{trip.display_name}</p>
          <p className="text-[11px] text-[#9B9A97] mt-0.5">
            {trip.cities.join(' → ')}
            {trip.cities.length > 0 && ' · '}
            {new Date(trip.earliest_check_in).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
            {' – '}
            {new Date(trip.latest_check_out).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
            {' · '}
            {trip.total_nights} night{trip.total_nights !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-3 flex-wrap justify-end">
          {trip.vvip_flag && (
            <span className="text-[10px] bg-[#FBEAF0] text-[#72243E] px-2 py-0.5 rounded-full font-medium">VVIP</span>
          )}
          {trip.vip_flag && !trip.vvip_flag && (
            <span className="text-[10px] bg-[#FAEEDA] text-[#633806] px-2 py-0.5 rounded-full font-medium">VIP</span>
          )}
          {trip.special_occasion && (
            <span className="text-[10px] bg-[#E6F1FB] text-[#0C447C] px-2 py-0.5 rounded-full font-medium">
              {trip.special_occasion}
            </span>
          )}
          {trip.is_multi_leg && (
            <span className="text-[10px] bg-[#F5F4F1] text-[#6B6A67] px-2 py-0.5 rounded-full">
              {trip.legs.length} properties
            </span>
          )}
          {trip.is_group_booking && (
            <span className="text-[10px] bg-[#E6F1FB] text-[#0C447C] px-2 py-0.5 rounded-full">
              Group
            </span>
          )}
        </div>
      </div>

      {/* Legs timeline */}
      <div>
        {trip.legs.map((leg, i) => (
          <TripLeg
            key={leg.id}
            booking={leg}
            isLast={i === trip.legs.length - 1}
            onClick={onLegClick}
          />
        ))}
      </div>
    </div>
  )
}
