import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/session'
import { runExtraction } from '@/lib/extract'

export async function POST() {
  try {
    await requireAuth()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runExtraction()
    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
