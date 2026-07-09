'use client'

import { usePathname } from 'next/navigation'

const SearchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
)

const titleMap: Record<string, string> = {
  '/studio/home': 'Home',
  '/studio/queue': 'Queue',
  '/studio/queue/bookings': 'Queue',
  '/studio/queue/clients': 'Queue',
  '/studio/trips': 'Trips',
  '/studio/clients': 'Clients',
  '/studio/trip-builder': 'Trip Builder',
  '/studio/commissions': 'Commissions',
}

function deriveTitle(pathname: string): string {
  if (titleMap[pathname]) return titleMap[pathname]
  if (pathname.startsWith('/studio/clients/')) return 'Client Profile'
  return 'Studio'
}

export function StudioTopbar() {
  const pathname = usePathname()
  const title = deriveTitle(pathname)

  return (
    <header className="h-[46px] bg-white border-b border-[#E5E4E0] flex items-center justify-between px-5 shrink-0">
      <h1 className="text-sm font-semibold text-[#0F0F0D]">{title}</h1>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Search"
          className="w-8 h-8 flex items-center justify-center rounded-md text-[#6B6A67] hover:bg-[#F5F4F1] transition-colors"
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          className="h-8 px-3 bg-[#0F0F0D] text-white text-xs font-medium rounded-md hover:bg-[#2a2a28] transition-colors"
        >
          New Booking
        </button>
      </div>
    </header>
  )
}
