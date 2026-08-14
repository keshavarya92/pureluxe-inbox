// Agency-specific Sabre config: Pseudo City Code and the consortium/chain
// rate-plan codes negotiated with each supplier. Values come from your
// Sabre account manager / Hotel Program Manager, not from this code.
// Ported from pureluxe-rates's src/auth/accessCodes.js — same env var
// names, so credentials can be copied across without renaming anything.

export function getPCC(): string {
  const pcc = process.env.SABRE_PCC
  if (!pcc) throw new Error('Sabre is not configured — set SABRE_PCC in .env.local')
  return pcc
}

// Single string only — Sabre auto-appends this to the PNR under /CD.
// Goes in RateInfoRef.CorpDiscount, not in RatePlanCandidates.
export const CORP_DISCOUNT = process.env.SABRE_CORP_DISCOUNT || null

type RatePlanCandidate = { RatePlanCode: string } | { RatePlanType: string }

function rpc(code: string): RatePlanCandidate {
  return { RatePlanCode: code }
}

// Group 1: consortium + priority chains — 11 entries, exactly at the
// Sabre limit (max 1-11 entries, max 8 with RatePlanCode). Serandipians
// first so it's always included even if a chain code is missing from
// the environment. All entries use Format 3 (RatePlanCode only).
export function getRatePlanGroup1(): RatePlanCandidate[] {
  const codes = [
    process.env.SABRE_CODE_SERANDIPIANS, // Consortium — first priority
    process.env.SABRE_CODE_FOUR_SEASONS,
    process.env.SABRE_CODE_MARRIOTT,
    process.env.SABRE_CODE_HYATT,
    process.env.SABRE_CODE_PENINSULA,
    process.env.SABRE_CODE_MANDARIN,
    process.env.SABRE_CODE_ROSEWOOD,
    process.env.SABRE_CODE_BELMOND,
    process.env.SABRE_CODE_AMAN,
    process.env.SABRE_CODE_SLH,
    process.env.SABRE_CODE_PREFERRED,
  ]
  return codes.filter((c): c is string => !!c).map(rpc)
}

// Group 2: remaining chains + BAR fallback. RatePlanType "8" (RC-G,
// published/BAR rate) is always appended regardless of env vars, so
// every Group 2 call returns at least public rates.
export function getRatePlanGroup2(): RatePlanCandidate[] {
  const codes = [
    process.env.SABRE_CODE_ACCOR,
    process.env.SABRE_CODE_DORCHESTER,
    process.env.SABRE_CODE_ROCCO_FORTE,
    process.env.SABRE_CODE_LHW,
    process.env.SABRE_CODE_IHG,
    process.env.SABRE_CODE_HILTON,
  ]
  const candidates = codes.filter((c): c is string => !!c).map(rpc)
  candidates.push({ RatePlanType: '8' }) // BAR — always present
  return candidates
}
