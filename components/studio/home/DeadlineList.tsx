import type { Booking } from '@/lib/studio/types'

interface Props {
  deadlines: Booking[]
}

function urgencyColor(deadline: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)

  if (deadline <= today)        return 'bg-[#E24B4A]'
  if (deadline <= tomorrowStr)  return 'bg-[#E24B4A]'
  return 'bg-[#EF9F27]'
}

function urgencyLabel(deadline: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)

  if (deadline <= today)       return 'Today'
  if (deadline <= tomorrowStr) return 'Tomorrow'
  return new Date(deadline).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

function urgencyTextColor(deadline: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)

  if (deadline <= today)       return 'text-[#E24B4A] font-medium'
  if (deadline <= tomorrowStr) return 'text-[#E24B4A] font-medium'
  return 'text-[#6B6A67]'
}

export function DeadlineList({ deadlines }: Props) {
  if (deadlines.length === 0) {
    return (
      <p className="text-[12px] text-[#9B9A97] py-4 text-center">
        No cancellation deadlines in the next 7 days.
      </p>
    )
  }

  return (
    <div>
      {deadlines.map(b => (
        <div key={b.id} className="flex items-center gap-3 py-2.5 border-b border-[#F5F4F1] last:border-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${urgencyColor(b.cancellation_deadline!)}`} />
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-medium text-[#0F0F0D] truncate">{b.client_name}</p>
            <p className="text-[11px] text-[#9B9A97] truncate">{b.hotel_name}</p>
          </div>
          <p className={`text-[11px] shrink-0 ${urgencyTextColor(b.cancellation_deadline!)}`}>
            {urgencyLabel(b.cancellation_deadline!)}
          </p>
        </div>
      ))}
    </div>
  )
}
