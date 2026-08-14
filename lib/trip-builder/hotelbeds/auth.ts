// Hotelbeds request signing. Unlike Sabre (../sabre/auth.ts), there is no
// token exchange/cache — every request carries its own per-call signature,
// so there's nothing to refresh on 401 the way Sabre's authorizedRequest
// does.
//
// Auth scheme (confirmed against developer.hotelbeds.com/documentation/
// getting-started/ 2026-08-11): two headers on every request —
//   Api-key:     the raw API key
//   X-Signature: hex SHA256(apiKey + secret + currentUnixTimestampSeconds)
//
// Credentials are read lazily (per call), not at module load — same reason
// as Sabre's auth.ts: hotelbedsAdapter is a static export pulled in by
// every caller of resolveRateSelection(), so a missing-config error must
// surface as a normal thrown error when fetchRate() runs, not crash the
// module graph at import time.

import { createHash } from 'crypto'

export class HotelbedsApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HotelbedsApiError'
    this.status = status
  }
}

function requireCredentials() {
  const apiKey  = process.env.HOTELBEDS_API_KEY
  const secret  = process.env.HOTELBEDS_SECRET
  const baseUrl = process.env.HOTELBEDS_BASE_URL
  if (!apiKey || !secret || !baseUrl) {
    throw new Error('Hotelbeds is not configured — set HOTELBEDS_API_KEY, HOTELBEDS_SECRET, HOTELBEDS_BASE_URL in .env.local')
  }
  return { apiKey, secret, baseUrl }
}

function buildSignature(apiKey: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  return createHash('sha256').update(apiKey + secret + timestamp).digest('hex')
}

// Signs and sends a request, returning the parsed JSON body. Throws
// HotelbedsApiError on any non-2xx response.
export async function signedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiKey, secret, baseUrl } = requireCredentials()
  const signature = buildSignature(apiKey, secret)

  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type':     'application/json',
      Accept:             'application/json',
      // Certification section 1 (Technical) asks for GZIP request/response
      // compression explicitly — Node's fetch (undici) already
      // transparently decompresses gzip/deflate/br whenever the server
      // sets Content-Encoding, so this header alone is enough; no
      // response-side handling needed.
      'Accept-Encoding':  'gzip',
      'Api-key':          apiKey,
      'X-Signature':      signature,
      ...init.headers,
    },
  })

  if (!res.ok) throw new HotelbedsApiError(res.status, await res.text().catch(() => res.statusText))
  return res.json() as Promise<T>
}
