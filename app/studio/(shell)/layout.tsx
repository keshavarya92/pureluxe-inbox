import { redirect } from 'next/navigation'
import { getStudioUser } from '@/lib/studio/auth'
import { SidebarNav } from '@/components/studio/SidebarNav'
import { StudioTopbar } from '@/components/studio/StudioTopbar'

export default async function StudioShellLayout({ children }: { children: React.ReactNode }) {
  const user = await getStudioUser()
  if (!user) redirect('/studio/login')

  return (
    <div className="flex h-screen bg-white [font-family:system-ui,sans-serif]">
      {/* Sidebar */}
      <aside className="w-[196px] flex flex-col bg-white border-r border-[#E5E4E0] shrink-0">
        {/* Logo block */}
        <div className="px-4 py-[18px] border-b border-[#E5E4E0] shrink-0">
          <p className="text-xs uppercase tracking-[0.2em] font-semibold text-[#0F0F0D]">
            Pureluxe
          </p>
          <p className="text-xs text-[#9B9A97] mt-0.5">Studio</p>
        </div>

        {/* Nav + user row — client component */}
        <SidebarNav name={user.name} email={user.email} />
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-h-0">
        <StudioTopbar />
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
