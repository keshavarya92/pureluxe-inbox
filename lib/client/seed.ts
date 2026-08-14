// Deterministic seeding for mock rate/fee generation — build brief §3:
// "seeded and deterministic within a conversation... cached so repeat
// queries about the same property in the same conversation return
// consistent numbers rather than re-randomizing." The hash IS the cache
// key/derivation here — same inputs always produce the same numbers, so
// no separate cache table/memoization layer is needed on top.

// FNV-1a 32-bit — fast, deterministic, good enough for mock data (not
// cryptographic).
export function hashSeed(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// mulberry32 — small, fast, deterministic PRNG.
export function mulberry32(seed: number): () => number {
  let a = seed
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min
}

export function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)]
}

// Sample `count` items without replacement (order shuffled), via a seeded
// partial Fisher-Yates. Used to pick a handful of room features from a
// larger pool deterministically.
export function pickMany<T>(rng: () => number, items: T[], count: number): T[] {
  const pool = [...items]
  const result: T[] = []
  const n = Math.min(count, pool.length)
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng() * pool.length)
    result.push(pool[idx])
    pool.splice(idx, 1)
  }
  return result
}
