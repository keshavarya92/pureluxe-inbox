'use client'

interface TripSummary {
  id:    string
  title: string | null
}

const ChevronLeftIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
)

const ChevronRightIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

interface Props {
  trips:              TripSummary[]
  activeTripId:       string | null
  collapsed:          boolean
  guestName:          string
  onSelectTrip:       (id: string) => void
  onNewTrip:          () => void
  onToggleCollapse:   () => void
  onOpenProfile:      () => void
}

export function TripListSidebar({ trips, activeTripId, collapsed, guestName, onSelectTrip, onNewTrip, onToggleCollapse, onOpenProfile }: Props) {
  const initial = guestName.charAt(0).toUpperCase()

  if (collapsed) {
    return (
      <div className="flex flex-col items-center h-full py-3 gap-3">
        <button
          onClick={onToggleCollapse}
          title="Expand trip list"
          className="w-8 h-8 flex items-center justify-center rounded-md text-[#6B6A67] hover:bg-[#F5F4F1]"
        >
          <ChevronRightIcon />
        </button>
        <button
          onClick={onNewTrip}
          title="New trip"
          className="w-8 h-8 flex items-center justify-center rounded-md text-[#0F0F0D] border border-[#E5E4E0] hover:bg-[#F5F4F1] text-base leading-none"
        >
          +
        </button>
        <div className="flex-1" />
        <button
          onClick={onOpenProfile}
          title="View profile"
          className="w-7 h-7 rounded-full bg-[#0F0F0D] text-white text-[11px] font-medium flex items-center justify-center shrink-0"
        >
          {initial}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 py-3 shrink-0">
        <button
          onClick={onNewTrip}
          className="flex-1 text-left text-[12.5px] font-medium text-[#0F0F0D] border border-[#E5E4E0] rounded-md px-3 py-2 hover:bg-[#F5F4F1]"
        >
          + New trip
        </button>
        <button
          onClick={onToggleCollapse}
          title="Collapse trip list"
          className="w-7 h-7 flex items-center justify-center rounded-md text-[#9B9A97] hover:bg-[#F5F4F1] hover:text-[#6B6A67] shrink-0 ml-1"
        >
          <ChevronLeftIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {trips.length === 0 && (
          <p className="text-[11.5px] text-[#9B9A97] px-2 py-2">No trips yet — start one above.</p>
        )}
        {trips.map(trip => (
          <button
            key={trip.id}
            onClick={() => onSelectTrip(trip.id)}
            className={[
              'w-full text-left text-[13px] px-3 py-2 rounded-md truncate transition-colors',
              trip.id === activeTripId
                ? 'bg-[#F5F4F1] text-[#0F0F0D] font-medium'
                : 'text-[#6B6A67] hover:bg-[#F5F4F1]',
            ].join(' ')}
          >
            {trip.title ?? 'New trip'}
          </button>
        ))}
      </div>

      <button
        onClick={onOpenProfile}
        className="flex items-center gap-2.5 px-3 py-3 border-t border-[#E5E4E0] shrink-0 hover:bg-[#F5F4F1] text-left"
      >
        <div className="w-7 h-7 rounded-full bg-[#0F0F0D] text-white text-[11px] font-medium flex items-center justify-center shrink-0">
          {initial}
        </div>
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium text-[#0F0F0D] truncate">{guestName}</p>
          <p className="text-[10.5px] text-[#9B9A97] truncate">View profile</p>
        </div>
      </button>
    </div>
  )
}
