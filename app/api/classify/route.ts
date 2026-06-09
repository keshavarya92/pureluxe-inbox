import { NextResponse } from 'next/server'

// Classification pipeline removed — use /api/admin/extract instead.
export async function POST() {
  return NextResponse.json({ message: 'Classification pipeline removed. Use /api/admin/extract.' }, { status: 410 })
}
