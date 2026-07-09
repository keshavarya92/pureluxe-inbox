import type { DuplicateWarning as DuplicateWarningType } from '@/lib/studio/types'

interface Props {
  warning: DuplicateWarningType
}

export function DuplicateWarning({ warning }: Props) {
  const isDupeRef = warning.type === 'same_ref'
  const bg    = isDupeRef ? 'bg-[#FBEAF0] border-[#F4C0D1]' : 'bg-[#FAEEDA] border-[#FAC775]'
  const text  = isDupeRef ? 'text-[#72243E]' : 'text-[#633806]'

  return (
    <div className={`${bg} ${text} border rounded-md px-3 py-2 text-[11px] flex items-start gap-2 mb-3`}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-px">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      <span>{warning.message}
        {warning.related_booking_hotel && (
          <span className="font-medium"> — {warning.related_booking_hotel}
            {warning.related_booking_dates && ` (${warning.related_booking_dates})`}
          </span>
        )}
      </span>
    </div>
  )
}
