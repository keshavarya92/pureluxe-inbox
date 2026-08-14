// Sabre OAuth2 token cache + authorized fetch wrapper, ported from the
// standalone pureluxe-rates prototype (src/auth/sabreAuth.js).
//
// Credentials are read lazily, not at module load — unlike the original
// prototype (which threw on import if SABRE_* vars were missing), Sabre
// is optional here. gdsAdapter (rate-sources.ts) is a static export that
// every caller of resolveRateSelection() pulls in, so a missing-config
// error must surface as a normal RateSourceError when fetchRate() runs,
// not crash the module graph at import time.

interface CachedToken {
  accessToken: string
  expiresAt:   number
}

let cachedToken:  CachedToken | null = null
let pendingFetch: Promise<string> | null = null

const REFRESH_BUFFER_MS = 60_000 // refresh when within 60s of expiry

export class SabreApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'SabreApiError'
    this.status = status
  }
}

function requireCredentials() {
  const clientId     = process.env.SABRE_CLIENT_ID
  const clientSecret = process.env.SABRE_CLIENT_SECRET
  const endpoint      = process.env.SABRE_ENDPOINT
  if (!clientId || !clientSecret || !endpoint) {
    throw new Error('Sabre is not configured — set SABRE_CLIENT_ID, SABRE_CLIENT_SECRET, SABRE_ENDPOINT in .env.local')
  }
  return { clientId, clientSecret, endpoint }
}

// Sabre requires: base64( base64(clientId) + ":" + base64(clientSecret) )
function encodeSecret(clientId: string, clientSecret: string): string {
  return Buffer.from(
    Buffer.from(clientId).toString('base64') + ':' + Buffer.from(clientSecret).toString('base64')
  ).toString('base64')
}

function isTokenValid(): boolean {
  return cachedToken !== null && Date.now() < cachedToken.expiresAt - REFRESH_BUFFER_MS
}

async function fetchToken(): Promise<string> {
  const { clientId, clientSecret, endpoint } = requireCredentials()

  const res = await fetch(`${endpoint}/v2/auth/token`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:  `Basic ${encodeSecret(clientId, clientSecret)}`,
    },
    body: 'grant_type=client_credentials',
  })

  if (!res.ok) throw new SabreApiError(res.status, `Sabre auth token request failed: ${await res.text().catch(() => res.statusText)}`)

  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1_000 }
  return cachedToken.accessToken
}

// Returns a valid token. Concurrent callers during a refresh all await the
// same fetchToken() promise — no thundering herd.
export async function getToken(): Promise<string> {
  if (isTokenValid()) return cachedToken!.accessToken
  if (!pendingFetch) pendingFetch = fetchToken().finally(() => { pendingFetch = null })
  return pendingFetch
}

// Executes a Sabre call with a valid Bearer token. On 401: clears the
// cache, fetches a fresh token, retries once. Any other non-2xx response
// throws SabreApiError — callers use withRetry() (retry.ts) for transient
// (5xx/network) retries.
export async function authorizedRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const run = async (token: string): Promise<T> => {
    const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new SabreApiError(res.status, await res.text().catch(() => res.statusText))
    return res.json() as Promise<T>
  }

  const token = await getToken()
  try {
    return await run(token)
  } catch (err) {
    if (!(err instanceof SabreApiError) || err.status !== 401) throw err
    cachedToken = null
    const freshToken = await getToken()
    return run(freshToken)
  }
}
