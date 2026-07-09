import { redirect } from 'next/navigation'
import { getStudioUser } from '@/lib/studio/auth'

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
  </svg>
)

export default async function StudioLoginPage() {
  const user = await getStudioUser()
  if (user) redirect('/studio/home')

  return (
    <div className="min-h-screen bg-[#0F0F0D] flex items-center justify-center">
      <div className="flex flex-col items-center gap-8">
        {/* Logo */}
        <div className="flex flex-col items-center gap-1">
          <p className="text-white text-sm uppercase tracking-[0.22em] font-medium">
            Pureluxe
          </p>
          <p className="text-[#6B6A67] text-sm">Studio</p>
        </div>

        {/* Auth card */}
        <div className="flex flex-col items-center gap-4">
          <a
            href="/api/auth?next=/studio/home"
            className="flex items-center gap-3 bg-white text-[#0F0F0D] px-6 py-3 rounded-lg text-sm font-medium shadow-sm hover:bg-[#F5F4F1] transition-colors"
          >
            <GoogleIcon />
            Sign in with Google
          </a>
          <p className="text-[#4B4A47] text-xs">
            Access restricted to KFT team members
          </p>
        </div>
      </div>
    </div>
  )
}
