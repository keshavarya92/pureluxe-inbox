// Exponential backoff for transient Sabre errors (5xx, network, timeout).
// Ported from pureluxe-rates's src/utils/retry.js.
//
// 401 is never retried here — auth.ts's authorizedRequest() already
// refreshes the token and retries once; a 401 reaching this layer means
// that already failed, so it's surfaced immediately rather than retried
// against a token that just proved bad.

import { SabreApiError } from './auth'

const MAX_RETRIES   = 3
const BASE_DELAY_MS = 500 // delays: 500ms -> 1000ms -> 2000ms

export async function withRetry<T>(fn: () => Promise<T>, context = 'unknown'): Promise<T> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (err instanceof SabreApiError && err.status === 401) throw err

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1)
        console.warn(`[sabre] retrying ${context} after error (attempt ${attempt}/${MAX_RETRIES}, next delay ${delay}ms):`, err instanceof Error ? err.message : err)
        await sleep(delay)
      }
    }
  }

  console.error(`[sabre] ${context} exhausted ${MAX_RETRIES} retries:`, lastError instanceof Error ? lastError.message : lastError)
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
