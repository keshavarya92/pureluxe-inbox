import type { Booking } from '@/lib/studio/types'

interface Props {
  booking: Booking
  isLast: boolean
  onClick: (booking: Booking) => void
}

function formatDate(d: string | null): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

function deadlineUrgency(deadline: string | null): 'red' | 'amber' | null {
  if (!deadline) return null
  const today = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)
  if (deadline <= today)        return 'red'
  if (deadline <= tomorrowStr)  return 'red'
  return 'amber'
}

export function TripLeg({ booking, isLast, onClick }: Props) {
  const urgency = deadlineUrgency(booking.cancellation_deadline)
  const dotColor =
    urgency === 'red'   ? 'bg-[#E24B4A]' :
    urgency === 'amber' ? 'bg-[#EF9F27]' :
    'bg-[#9B9A97]'

  return (
    <div className="flex gap-3 cursor-pointer group" onClick={() => onClick(booking)}>
      {/* Timeline spine */}
      <div className="flex flex-col items-center w-4 shrink-0">
        <div className={`w-2 h-2 rounded-full mt-1 shrink-0 ${dotColor}`} />
        {!isLast && <div className="w-px flex-1 bg-[#E5E4E0] mt-1" />}
      </div>

      {/* Content */}
      <div className={`flex-1 ${!isLast ? 'pb-4' : ''}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-medium text-[#0F0F0D] group-hover:text-[#185FA5] truncate">
              {booking.hotel_name ?? 'Unknown hotel'}
              {booking.city && <span className="font-normal text-[#9B9A97]">, {booking.city}</span>}
            </p>
            <p className="text-[11px] text-[#9B9A97] mt-0.5">
              {formatDate(booking.check_in)} – {formatDate(booking.check_out)}
              {booking.nights && ` · ${booking.nights} night${booking.nights !== 1 ? 's' : ''}`}
              {booking.num_rooms && booking.num_rooms > 1 && ` · ${booking.num_rooms} rooms`}
            </p>
          </div>
          <div className="text-right shrink-0">
            {booking.total_cost && (
              <p className="text-[11px] text-[#0F0F0D]">
                {booking.currency} {booking.total_cost.toLocaleString()}
              </p>
            )}
            {booking.amadeus_ref && (
              <p className="text-[10px] text-[#9B9A97]">{booking.amadeus_ref}</p>
            )}
          </div>
        </div>

        {/* Flags row */}
        <div className="flex gap-2 mt-1.5 flex-wrap">
          {urgency && booking.cancellation_deadline && (
            <span className={`text-[10px] font-medium ${urgency === 'red' ? 'text-[#E24B4A]' : 'text-[#BA7517]'}`}>
              Cancel by {formatDate(booking.cancellation_deadline)}
              {urgency === 'red' && ' — urgent'}
            </span>
          )}
          {booking.special_occasion && (
            <span className="text-[10px] bg-[#E6F1FB] text-[#0C447C] px-1.5 py-0.5 rounded-full">
              {booking.special_occasion}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
