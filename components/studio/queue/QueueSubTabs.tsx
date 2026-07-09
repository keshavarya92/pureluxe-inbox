'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function QueueSubTabsClient() {
  const pathname = usePathname()

  const tabs = [
    { label: 'Bookings', href: '/studio/queue/bookings' },
    { label: 'Clients',  href: '/studio/queue/clients' },
  ]

  return (
    <div className="flex border-b border-[#E5E4E0] px-5 bg-white shrink-0">
      {tabs.map(tab => {
        const active = pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={[
              'text-[12px] px-1 py-3 mr-5 border-b-2 transition-colors',
              active
                ? 'border-[#0F0F0D] text-[#0F0F0D] font-medium'
                : 'border-transparent text-[#6B6A67] hover:text-[#0F0F0D]',
            ].join(' ')}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
