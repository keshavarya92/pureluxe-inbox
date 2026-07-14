import type { FamilyWithMembers } from '@/lib/studio/types'

interface Props {
  family: FamilyWithMembers
  currentClientId: string
  onNavigateToClient: (id: string) => void
}

const ROLE_LABEL: Record<string, string> = {
  primary:          'Primary',
  spouse:           'Spouse',
  parent:           'Parent',
  child:            'Child',
  sibling:          'Sibling',
  business_partner: 'Business partner',
  member:           'Member',
}

function initials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map(n => n[0].toUpperCase()).join('')
}

export function FamilyCard({ family, currentClientId, onNavigateToClient }: Props) {
  return (
    <div className="bg-[#F5F4F1] rounded-lg p-3">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12px] font-medium text-[#0F0F0D]">{family.family_name}</p>
        <p className="text-[10px] text-[#9B9A97]">
          ${family.total_spend_usd.toLocaleString()} total · {family.booking_count} bookings
        </p>
      </div>
      <div className="space-y-2">
        {family.members.map(member => {
          const name = (member.client as any)?.full_name ?? 'Unknown'
          const isCurrent = member.client_id === currentClientId
          return (
            <div key={member.id} className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-[#E5E4E0] flex items-center justify-center text-[9px] font-medium text-[#0F0F0D] shrink-0">
                {initials(name)}
              </div>
              <div className="flex-1 min-w-0">
                {isCurrent ? (
                  <p className="text-[11px] font-medium text-[#0F0F0D]">{name} <span className="text-[#9B9A97] font-normal">(you)</span></p>
                ) : (
                  <button
                    onClick={() => onNavigateToClient(member.client_id)}
                    className="text-[11px] text-[#185FA5] hover:underline text-left"
                  >
                    {name}
                  </button>
                )}
              </div>
              <p className="text-[10px] text-[#9B9A97] shrink-0">{ROLE_LABEL[member.role] ?? member.role}</p>
              {member.is_primary && (
                <span className="text-[9px] bg-[#E6F1FB] text-[#0C447C] px-1.5 py-0.5 rounded-full">Lead</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
