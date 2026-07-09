import { NextRequest, NextResponse } from 'next/server'
import { getTokensFromCode, getEmailAddress } from '@/lib/gmail'
import { getSession } from '@/lib/session'
import { upsertUser } from '@/lib/users'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')
  const next = searchParams.get('state')

  if (error) {
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(error)}`, req.url))
  }

  if (!code) {
    return NextResponse.redirect(new URL('/?error=no_code', req.url))
  }

  try {
    const tokens = await getTokensFromCode(code)

    if (!tokens.access_token) {
      throw new Error('No access token returned from Google')
    }

    // Fetch the user's email address from Gmail
    const email = await getEmailAddress(tokens.access_token)

    // Persist tokens in Supabase — session cookie only carries the email
    const expiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null
    await upsertUser(email, tokens.access_token, tokens.refresh_token ?? null, expiry)

    const session = await getSession()
    session.email = email
    await session.save()

    const destination = next && next.startsWith('/') ? next : '/?connected=1'
    return NextResponse.redirect(new URL(destination, req.url))
  } catch (err: any) {
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(err.message)}`, req.url)
    )
  }
}
