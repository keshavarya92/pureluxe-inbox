// Destination-level fee config (build brief §3: "resort fees, Maldives
// transfers ... still applies on top of generated base rates, same as
// production logic"). No such config actually exists yet anywhere else in
// this codebase (verified — the only real precedent is rate-extraction.ts
// instructing the paste-extraction LLM to fold a mandatory per-stay fee
// into rate_per_unit at extraction time, which isn't a reusable lookup).
// This is a genuinely new, small config built for the client demo, kept
// generic (not demo-only) so a future real fee system can replace it
// without changing callers — see lib/client/tools.ts's lookup_property_rates.

import { mulberry32, randInt } from './seed'

export interface FeeLine {
  label:  string
  amount: number
}

interface FeeRule {
  test:  (destination: string) => boolean
  build: (rng: () => number, nights: number) => FeeLine[]
}

const FEE_RULES: FeeRule[] = [
  {
    test: d => /maldives/i.test(d),
    build: (rng, nights) => [
      { label: 'Resort fee', amount: randInt(rng, 45, 85) * nights },
      { label: 'Seaplane transfer (return)', amount: randInt(rng, 600, 900) },
    ],
  },
  {
    test: d => /seychelles|mauritius/i.test(d),
    build: (rng, nights) => [
      { label: 'Resort fee', amount: randInt(rng, 35, 65) * nights },
      { label: 'Speedboat transfer (return)', amount: randInt(rng, 400, 700) },
    ],
  },
  {
    test: d => /italy|positano|amalfi|france|riviera|greece|santorini/i.test(d),
    build: (rng, nights) => [
      { label: 'City tax', amount: randInt(rng, 8, 15) * nights },
      { label: 'Private transfer', amount: randInt(rng, 300, 550) },
    ],
  },
  {
    // Fallback — every destination gets some fee line, since the brief
    // treats this as always-applied on top of the generated base rate,
    // not a Maldives-only special case.
    test: () => true,
    build: (rng, nights) => [
      { label: 'Resort fee', amount: randInt(rng, 20, 40) * nights },
    ],
  },
]

// seed is offset from the caller's base seed so this fee RNG stream
// doesn't correlate with (or accidentally mirror) the room-rate stream
// derived from the same base seed.
export function computeDestinationFees(destination: string, seed: number, nights: number): FeeLine[] {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const rule = FEE_RULES.find(r => r.test(destination)) ?? FEE_RULES[FEE_RULES.length - 1]
  return rule.build(rng, Math.max(1, nights))
}
