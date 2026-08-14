// Exponential backoff for transient Hotelbeds errors (5xx, network,
// timeout). Mirrors ../sabre/retry.ts's shape but is intentionally its own
// copy, not a shared helper — the two APIs' non-retryable-status carve-outs
// differ (see below) and Sabre is out of scope for this session.
//
// 401 (bad signature/key) and 403 (evaluation-account quota exceeded — 50
// requests/day per the docs) are never retried: neither is transient, and
// a fresh signature on retry won't fix a wrong key or an exhausted quota.

import { HotelbedsApiError } from './auth'

const MAX_RETRIES   = 3
const BASE_DELAY_MS = 500 // delays: 500ms -> 1000ms -> 2000ms

export async function withRetry<T>(fn: () => Promise<T>, context = 'unknown'): Promise<T> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (err instanceof HotelbedsApiError && (err.status === 401 || err.status === 403)) throw err

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1)
        console.warn(`[hotelbeds] retrying ${context} after error (attempt ${attempt}/${MAX_RETRIES}, next delay ${delay}ms):`, err instanceof Error ? err.message : err)
        await sleep(delay)
      }
    }
  }

  console.error(`[hotelbeds] ${context} exhausted ${MAX_RETRIES} retries:`, lastError instanceof Error ? lastError.message : lastError)
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
