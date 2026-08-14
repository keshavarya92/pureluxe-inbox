/**
 * rate-selection.ts — resolveRateSelection(), the single entry point that
 * turns a resolveRateRouting() decision (rate-routing.ts) into an actual
 * rate by calling the adapters in rate-sources.ts. Callers never touch
 * individual adapters — same pattern as resolveRateRouting() itself.
 *
 * Out of scope here (see session brief): real GDS/Sabre or wholesaler
 * integration (adapters are stubs — see rate-sources.ts), fee-config
 * total-cost math, UI surfacing of advisory_flag/consultant_required,
 * document generator hookup.
 */

import type { RateRoutingResult } from './rate-routing'
import {
  gdsAdapter,
  hotelbedsAdapter,
  createWholesalerAdapter,
  RateSourceError,
  type RateSource,
  type NormalizedRate,
  type TripContext,
} from './rate-sources'

export type RateSelectionResult =
  | { status: 'rate_found'; rate: NormalizedRate & { advisory_flag: boolean }; sources_checked: string[]; errors: SourceError[] }
  | { status: 'consultant_required'; sources_checked: string[]; errors: SourceError[] }

export interface SourceError {
  source:  string
  message: string
}

// Injectable so tests can swap in call-counting fakes instead of the real
// (currently all-stub) adapters — otherwise there's no way to exercise
// "lowest rate wins" or "retry fires exactly once" deterministically, since
// the real adapters always return null.
export interface RateSourceRegistry {
  gds:        RateSource
  bedbank:    RateSource
  wholesaler: (sourceId: string) => RateSource
}

export const defaultRateSources: RateSourceRegistry = {
  gds:        gdsAdapter,
  bedbank:    hotelbedsAdapter,
  wholesaler: createWholesalerAdapter,
}

function pickLowest(rates: NormalizedRate[]): NormalizedRate {
  return rates.reduce((best, r) => (r.base_rate < best.base_rate ? r : best))
}

export async function resolveRateSelection(
  routingDecision: RateRoutingResult,
  tripContext:      TripContext,
  sources:          RateSourceRegistry = defaultRateSources,
): Promise<RateSelectionResult> {
  const sourcesChecked: string[] = []
  const errors: SourceError[] = []

  async function tryFetch(source: RateSource): Promise<NormalizedRate | null> {
    sourcesChecked.push(source.id)
    try {
      return await source.fetchRate(tripContext)
    } catch (err) {
      const message = err instanceof RateSourceError || err instanceof Error ? err.message : String(err)
      console.error(`[rate-selection] source=${source.id} error: ${message}`)
      errors.push({ source: source.id, message })
      return null
    }
  }

  // Path 1 — fully offline trip type. Full consultant handoff, no rate
  // search at all: not even a single adapter call.
  if (routingDecision.path === 1) {
    console.log('[rate-selection] path=1 consultant_required — offline trip type, no adapter calls')
    return { status: 'consultant_required', sources_checked: sourcesChecked, errors }
  }

  // Path 5 — high-value destination/property. Check wholesale/offline
  // first, skipping GDS/OTA; fall back to GDS/bedbank only if wholesale has
  // no availability, retrying that fallback once before giving up.
  if (routingDecision.path === 5) {
    const wholesaleSource = sources.wholesaler(routingDecision.wholesale_source)
    const wholesaleRate = await tryFetch(wholesaleSource)
    if (wholesaleRate) {
      console.log(`[rate-selection] path=5 rate found via wholesale source=${wholesaleSource.id}`)
      return {
        status: 'rate_found',
        rate: { ...wholesaleRate, advisory_flag: true },
        sources_checked: sourcesChecked,
        errors,
      }
    }

    const fallbackAttempt = async (): Promise<NormalizedRate[]> => {
      const results = await Promise.all([tryFetch(sources.gds), tryFetch(sources.bedbank)])
      return results.filter((r): r is NormalizedRate => r != null)
    }

    let fallbackResults = await fallbackAttempt()
    if (!fallbackResults.length) {
      console.log('[rate-selection] path=5 fallback (GDS/bedbank) empty on first attempt — retrying once')
      fallbackResults = await fallbackAttempt()
    }

    if (fallbackResults.length) {
      const best = pickLowest(fallbackResults)
      console.log(`[rate-selection] path=5 fallback rate found via source=${best.source}`)
      return {
        status: 'rate_found',
        rate: { ...best, advisory_flag: false },
        sources_checked: sourcesChecked,
        errors,
      }
    }

    console.log('[rate-selection] path=5 wholesale + fallback both exhausted — consultant_required')
    return { status: 'consultant_required', sources_checked: sourcesChecked, errors }
  }

  // Path 2-4 — GDS + bedbank (+ wholesaler if present) in parallel, pick
  // the lowest base_rate among successes, retrying the whole parallel
  // attempt once if every source came back empty/errored.
  const buildSources = (): RateSource[] => {
    const list: RateSource[] = [sources.gds, sources.bedbank]
    if (routingDecision.wholesaler && routingDecision.wholesale_source) {
      list.push(sources.wholesaler(routingDecision.wholesale_source))
    }
    return list
  }

  const parallelAttempt = async (): Promise<NormalizedRate[]> => {
    const results = await Promise.all(buildSources().map(tryFetch))
    return results.filter((r): r is NormalizedRate => r != null)
  }

  let results = await parallelAttempt()
  if (!results.length) {
    console.log('[rate-selection] path=2-4 all sources empty/errored on first attempt — retrying once')
    results = await parallelAttempt()
  }

  if (results.length) {
    const best = pickLowest(results)
    console.log(`[rate-selection] path=2-4 rate found via source=${best.source} (lowest of ${results.length})`)
    return {
      status: 'rate_found',
      rate: { ...best, advisory_flag: false },
      sources_checked: sourcesChecked,
      errors,
    }
  }

  console.log('[rate-selection] path=2-4 exhausted after retry — consultant_required')
  return { status: 'consultant_required', sources_checked: sourcesChecked, errors }
}
