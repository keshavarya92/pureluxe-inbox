import type { Booking } from '@/lib/studio/types'

interface Props {
  checkins: Booking[]
  emptyMessage?: string
}

function initials(name: string | null): string {
  if (!name) return '?'
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(n => n[0].toUpperCase())
    .join('')
}

export function CheckinList({ checkins, emptyMessage }: Props) {
  if (checkins.length === 0) {
    return (
      <p className="text-[12px] text-[#9B9A97] py-4 text-center">
        {emptyMessage ?? 'No check-ins today.'}
      </p>
    )
  }

  return (
    <div>
      {checkins.map(b => {
        const nights = b.nights ?? 0
        return (
          <div key={b.id} className="flex items-center gap-3 py-2.5 border-b border-[#F5F4F1] last:border-0">
            <div className="w-8 h-8 rounded-full bg-[#F5F4F1] flex items-center justify-center text-[11px] font-medium text-[#0F0F0D] shrink-0">
              {initials(b.client_name)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-medium text-[#0F0F0D] truncate">{b.client_name}</p>
              <p className="text-[11px] text-[#9B9A97] truncate">
                {b.hotel_name}{nights > 0 ? ` · ${nights} night${nights !== 1 ? 's' : ''}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {b.vip_flag && (
                <span className="text-[9px] bg-[#FAEEDA] text-[#633806] px-1.5 py-0.5 rounded-full font-medium">VIP</span>
              )}
              {b.vvip_flag && (
                <span className="text-[9px] bg-[#FBEAF0] text-[#72243E] px-1.5 py-0.5 rounded-full font-medium">VVIP</span>
              )}
              {b.special_occasion && (
                <span className="text-[9px] bg-[#E6F1FB] text-[#0C447C] px-1.5 py-0.5 rounded-full font-medium">
                  {b.special_occasion}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
