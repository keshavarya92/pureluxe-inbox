import { NextRequest, NextResponse } from 'next/server'
import { getAuthUrl } from '@/lib/gmail'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const next = searchParams.get('next') ?? undefined
  const url = getAuthUrl(next)
  // When ?next= is present the caller is an <a href> (e.g. Studio login button)
  // — redirect straight to Google so the browser follows without JS.
  // Without ?next= the existing fetch-then-redirect JS flow receives { url } as before.
  if (next) {
    return NextResponse.redirect(url)
  }
  return NextResponse.json({ url })
}
