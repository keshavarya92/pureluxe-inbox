import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { searchFamilies } from '@/lib/studio/queries'

export async function GET(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = req.nextUrl.searchParams.get('q') ?? ''
  const families = await searchFamilies(q)
  return NextResponse.json({ families })
}
