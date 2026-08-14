// Small presentation helpers trimmed from pureluxe-rates's
// src/utils/hotelFormatter.js — just the pieces gdsAdapter (rate-sources.ts)
// needs to turn a raw Sabre rate into readable NormalizedRate fields.

const BOARD_BASIS: Record<string, string> = {
  EP: 'Room Only', RO: 'Room Only',
  CP: 'Bed & Breakfast', BB: 'Bed & Breakfast', BP: 'Bed & Breakfast',
  HB: 'Half Board', MAP: 'Half Board',
  FB: 'Full Board', FAP: 'Full Board', AP: 'Full Board',
  AI: 'All Inclusive', UAI: 'Ultra All Inclusive',
}

export function mapBoardBasis(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = String(raw).trim().toUpperCase()
  return BOARD_BASIS[key] ?? raw // fall back to verbatim if unknown code
}

export function formatCancellation(penalties: unknown, isRefundable: boolean): string {
  const list = ([] as any[]).concat(penalties ?? []).filter(Boolean)

  if (list.length === 0) {
    return isRefundable ? 'Fully refundable — no cancellation fee' : 'Non-refundable'
  }

  const lines: string[] = []
  for (const p of list) {
    const textNodes = ([] as any[]).concat(p.PenaltyDescription?.Text ?? [])
    const textLine = textNodes
      .map((t: any) => t?.value ?? t?._ ?? (typeof t === 'string' ? t : null))
      .filter(Boolean)
      .join(' ')
      .trim()

    if (textLine) { lines.push(textLine); continue }

    const dateRaw = p.Deadline?.AbsoluteDeadline ?? p.CancelByDate ?? null
    const amount  = p.EstimatedPenaltyAmount ?? p.Amount ?? null

    if (dateRaw && amount)  lines.push(`Cancel by ${dateRaw} to avoid ${amount} fee`)
    else if (dateRaw)       lines.push(`Cancel by ${dateRaw}`)
    else if (amount)        lines.push(`Cancellation fee: ${amount}`)
    else                    lines.push('Cancellation terms apply — verify with hotel')
  }

  return lines.length > 0 ? lines.join('. ') : (isRefundable ? 'Fully refundable' : 'Non-refundable')
}

export function calcNights(checkIn: string, checkOut: string): number {
  const msPerDay = 86_400_000
  const nights   = Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / msPerDay)
  return nights > 0 ? nights : 1
}
