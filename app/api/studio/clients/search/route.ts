import { NextRequest, NextResponse } from 'next/server'
import { getStudioUser } from '@/lib/studio/auth'
import { searchClients } from '@/lib/studio/queries'

export async function GET(req: NextRequest) {
  const user = await getStudioUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q') ?? ''
  const exclude = searchParams.get('exclude') ?? undefined

  try {
    const clients = await searchClients(q, exclude)
    return NextResponse.json({ clients })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
