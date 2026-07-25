import type { Booking } from '@/lib/studio/types'

interface Props {
  booking: Booking
  isSelected: boolean
  onClick: () => void
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
}

const STATUS_STYLE: Record<string, string> = {
  confirmed:     'bg-[#EAF3DE] text-[#27500A]',
  checked_out:   'bg-[#F5F4F1] text-[#6B6A67]',
  pending_review:'bg-[#FAEEDA] text-[#633806]',
  cancelled:     'bg-[#FCEBEB] text-[#791F1F]',
  superseded:    'bg-[#F5F4F1] text-[#9B9A97]',
  enquiry:       'bg-[#E6F1FB] text-[#0C447C]',
  pending:       'bg-[#FAEEDA] text-[#633806]',
  rejected:      'bg-[#FCEBEB] text-[#791F1F]',
}

export function BookingRow({ booking, isSelected, onClick }: Props) {
  const statusStyle = STATUS_STYLE[booking.status] ?? 'bg-[#F5F4F1] text-[#6B6A67]'
  const ref = booking.amadeus_ref ?? booking.hotel_ref ?? booking.lhw_ref ?? '—'

  return (
    <tr
      onClick={onClick}
      className={`cursor-pointer border-b border-[#F5F4F1] hover:bg-[#F5F4F1] transition-colors ${
        isSelected ? 'bg-[#F0F4FF]' : ''
      }`}
    >
      <td className="px-4 py-3 max-w-[180px]">
        <div className="flex items-center gap-2">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-[#0F0F0D] truncate">{booking.client_name ?? '—'}</p>
            {(booking.vip_flag || booking.vvip_flag) && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                booking.vvip_flag ? 'bg-[#FBEAF0] text-[#72243E]' : 'bg-[#FAEEDA] text-[#633806]'
              }`}>
                {booking.vvip_flag ? 'VVIP' : 'VIP'}
              </span>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 max-w-[200px]">
        <p className="text-[12px] text-[#0F0F0D] truncate">{booking.hotel_name ?? '—'}</p>
        <p className="text-[10px] text-[#9B9A97] truncate">{booking.city ?? ''}</p>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <p className="text-[12px] text-[#0F0F0D]">{formatDate(booking.check_in)}</p>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <p className="text-[12px] text-[#0F0F0D]">{formatDate(booking.check_out)}</p>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <p className="text-[12px] text-[#0F0F0D]">{booking.nights ?? '—'}</p>
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-right">
        {booking.total_cost ? (
          <p className="text-[12px] text-[#0F0F0D]">
            {booking.currency} {booking.total_cost.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        ) : (
          <p className="text-[12px] text-[#9B9A97]">—</p>
        )}
      </td>
      <td className="px-4 py-3">
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${statusStyle}`}>
          {booking.status}
        </span>
      </td>
      <td className="px-4 py-3">
        <p className="text-[11px] text-[#9B9A97] truncate max-w-[120px]">
          {booking.booked_by_name?.split('@')[0] ?? '—'}
        </p>
      </td>
      <td className="px-4 py-3">
        <p className="text-[11px] text-[#9B9A97] font-mono">{ref}</p>
      </td>
    </tr>
  )
}
