// Small presentation helpers for turning a raw HotelbedsRate into readable
// NormalizedRate fields — mirrors ../sabre/format.ts's role for gdsAdapter,
// but Hotelbeds' own field shapes (board codes, cancellationPolicies array)
// differ enough from Sabre's that sharing code isn't a clean fit.

import type { HotelbedsCancellationPolicy } from './hotel-search'

const BOARD_BASIS: Record<string, string> = {
  RO: 'Room Only', SC: 'Self Catering', CB: 'Continental Breakfast',
  BB: 'Bed & Breakfast', HB: 'Half Board', FB: 'Full Board',
  AI: 'All Inclusive', UAI: 'Ultra All Inclusive',
}

export function mapBoardBasis(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = String(raw).trim().toUpperCase()
  return BOARD_BASIS[key] ?? raw // fall back to verbatim if unknown code
}

// An empty cancellationPolicies array means Hotelbeds returned no free-
// cancellation deadline for this rate — conventionally non-refundable, not
// "no data." Each entry lists the fee due if cancelling on/after `from`.
export function formatCancellation(policies: HotelbedsCancellationPolicy[], currency: string | null | undefined): string {
  if (!policies.length) return 'Non-refundable — no cancellation deadline returned'

  return policies
    .map(p => `Cancel before ${p.from} to avoid a ${currency ?? ''} ${p.amount} fee`.replace(/\s+/g, ' ').trim())
    .join('. ')
}
