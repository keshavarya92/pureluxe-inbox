import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { searchClientDirectory } from '@/lib/studio/queries'

export async function GET(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q      = req.nextUrl.searchParams.get('q') ?? ''
  const sort   = (req.nextUrl.searchParams.get('sort') ?? 'name_asc') as any
  const filter = (req.nextUrl.searchParams.get('filter') ?? 'all') as any

  try {
    const clients = await searchClientDirectory(q, sort, filter)
    return NextResponse.json({ clients })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
