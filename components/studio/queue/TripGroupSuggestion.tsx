import type { TripSuggestion } from '@/lib/studio/types'

interface Props {
  suggestion: TripSuggestion
  onGroup: (tripId: string) => void
  onDismiss: () => void
}

const REASON_LABEL: Record<TripSuggestion['reason'], string> = {
  same_pnr:          'Same PNR',
  consecutive_dates: 'Consecutive dates',
  same_group_name:   'Same group',
}

export function TripGroupSuggestion({ suggestion, onGroup, onDismiss }: Props) {
  return (
    <div className="bg-[#E6F1FB] border border-[#B5D4F4] rounded-md px-3 py-2 text-[11px] text-[#0C447C] flex items-center gap-2 mb-3">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
        <circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
        <circle cx="18" cy="5" r="3" />
      </svg>
      <span className="flex-1">
        <span className="font-medium">{REASON_LABEL[suggestion.reason]}</span>
        {' — '}Group with <span className="font-medium">{suggestion.trip_label}</span>?
      </span>
      <button
        onClick={() => onGroup(suggestion.suggested_trip_id)}
        className="bg-[#0C447C] text-white text-[10px] px-2 py-1 rounded hover:opacity-90"
      >
        Group
      </button>
      <button
        onClick={onDismiss}
        className="text-[#0C447C] text-[10px] px-2 py-1 rounded hover:bg-[#B5D4F4]"
      >
        Keep separate
      </button>
    </div>
  )
}
