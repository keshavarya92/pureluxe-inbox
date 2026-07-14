import type { ClientRecord } from '@/lib/studio/types'

interface Props {
  client: ClientRecord
  isSelected: boolean
  onClick: () => void
  familyName?: string
  lastBooking?: string
}

function initials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map(n => n[0].toUpperCase()).join('')
}

export function ClientListItem({ client, isSelected, onClick, familyName, lastBooking }: Props) {
  return (
    <button
      onClick={onClick}
      className={[
        'w-full flex items-center gap-3 px-4 py-3 text-left border-b border-[#F5F4F1] hover:bg-[#F5F4F1] transition-colors',
        isSelected ? 'bg-[#F5F4F1]' : 'bg-white',
      ].join(' ')}
    >
      <div className="w-8 h-8 rounded-full bg-[#E5E4E0] flex items-center justify-center text-[11px] font-medium text-[#0F0F0D] shrink-0">
        {initials(client.full_name)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-[12px] font-medium text-[#0F0F0D] truncate">{client.full_name}</p>
          {client.vip_level === 'vvip' && (
            <span className="text-[9px] bg-[#FBEAF0] text-[#72243E] px-1.5 py-0.5 rounded-full font-medium shrink-0">VVIP</span>
          )}
          {client.vip_level === 'vip' && (
            <span className="text-[9px] bg-[#FAEEDA] text-[#633806] px-1.5 py-0.5 rounded-full font-medium shrink-0">VIP</span>
          )}
        </div>
        <p className="text-[11px] text-[#9B9A97] truncate">
          {familyName ? `${familyName} · ` : ''}{lastBooking ?? (client.email ?? client.phone ?? 'No contact info')}
        </p>
      </div>
    </button>
  )
}
