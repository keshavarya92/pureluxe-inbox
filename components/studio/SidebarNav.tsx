'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// --- Icons ---

const HouseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
)

const InboxIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
)

const RouteIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="19" r="3" />
    <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
    <circle cx="18" cy="5" r="3" />
  </svg>
)

const MapIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" />
    <line x1="9" x2="9" y1="3" y2="18" />
    <line x1="15" x2="15" y1="6" y2="21" />
  </svg>
)

const BookingsIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" x2="16" y1="2" y2="6" />
    <line x1="8" x2="8" y1="2" y2="6" />
    <line x1="3" x2="21" y1="10" y2="10" />
    <path d="m9 16 2 2 4-4" />
  </svg>
)

const UsersIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
)

const ChatIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

const CoinsIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6" />
    <path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
    <path d="M7 6h1v4" />
    <path d="m16.71 13.88.7.71-2.82 2.82" />
  </svg>
)

// --- Chip ---

const ComingSoonChip = () => (
  <span className="bg-[#F1EFE8] text-[#9B9A97] text-[10px] leading-none px-[6px] py-[3px] rounded-[10px] shrink-0">
    Soon
  </span>
)

// --- Nav data ---

interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
  comingSoon?: boolean
}

const opsNav: NavItem[] = [
  { label: 'Home', href: '/studio/home', icon: <HouseIcon /> },
  { label: 'Queue', href: '/studio/queue', icon: <InboxIcon /> },
  { label: 'Bookings', href: '/studio/bookings', icon: <BookingsIcon /> },
  { label: 'Trip Builder', href: '/studio/trip-builder', icon: <RouteIcon />, comingSoon: true },
  { label: 'Trips', href: '/studio/trips', icon: <MapIcon /> },
  { label: 'Clients', href: '/studio/clients', icon: <UsersIcon /> },
  { label: 'Trainer', href: '/studio/trainer', icon: <ChatIcon /> },
]

const financeNav: NavItem[] = [
  { label: 'Commissions', href: '/studio/commissions', icon: <CoinsIcon />, comingSoon: true },
]

// --- Sub-components ---

function SectionLabel({ label }: { label: string }) {
  return (
    <p className="text-[10px] font-semibold text-[#9B9A97] uppercase tracking-wider px-[10px] pt-4 pb-1 first:pt-2">
      {label}
    </p>
  )
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={[
        'flex items-center gap-[10px] w-full px-[10px] py-[7px] rounded-md text-sm transition-colors',
        active
          ? 'bg-[#F5F4F1] text-[#0F0F0D] font-medium'
          : 'text-[#6B6A67] hover:bg-[#F5F4F1]',
      ].join(' ')}
    >
      <span className="shrink-0">{item.icon}</span>
      <span className="flex-1 truncate">{item.label}</span>
      {item.comingSoon && <ComingSoonChip />}
    </Link>
  )
}

// --- Main export ---

interface Props {
  name: string
  email: string
}

export function SidebarNav({ name, email }: Props) {
  const pathname = usePathname()

  const isActive = (href: string) => {
    if (href === '/studio/home') return pathname === '/studio/home'
    return pathname.startsWith(href)
  }

  const initial = name.charAt(0).toUpperCase()

  return (
    <>
      <nav className="flex-1 overflow-y-auto px-2 py-1">
        <SectionLabel label="Operations" />
        {opsNav.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}
        <SectionLabel label="Finance" />
        {financeNav.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}
      </nav>

      <div className="border-t border-[#E5E4E0] px-3 py-3 flex items-center gap-2 shrink-0">
        <div className="w-7 h-7 rounded-full bg-[#0F0F0D] flex items-center justify-center text-white text-[11px] font-medium shrink-0">
          {initial}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-[#0F0F0D] truncate">{name}</p>
          <p className="text-[10px] text-[#9B9A97] truncate">{email}</p>
        </div>
      </div>
    </>
  )
}
