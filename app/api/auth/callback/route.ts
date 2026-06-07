import { NextRequest, NextResponse } from 'next/server'
import { getTokensFromCode } from '@/lib/gmail'
import { getSession } from '@/lib/session'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(error)}`, req.url))
  }

  if (!code) {
    return NextResponse.redirect(new URL('/?error=no_code', req.url))
  }

  try {
    const tokens = await getTokensFromCode(code)

    // Store tokens in encrypted httpOnly cookie — never in URL or client state
    const session = await getSession()
    session.accessToken = tokens.access_token || ''
    session.refreshToken = tokens.refresh_token || ''
    await session.save()

    // Redirect cleanly — no tokens in URL
    return NextResponse.redirect(new URL('/?connected=1', req.url))
  } catch (err: any) {
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(err.message)}`, req.url)
    )
  }
}
