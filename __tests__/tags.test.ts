import { describe, it, expect } from 'vitest'
import { extractTags, sectionsForTags, requiresExtraction, TAG_SECTIONS } from '../lib/tags'
import { matchGdsWhitelist } from '../lib/config/gdsWhitelist'

// ---------------------------------------------------------------------------
// extractTags
// ---------------------------------------------------------------------------

describe('extractTags', () => {
  it('extracts a single tag anywhere in the subject', () => {
    expect(extractTags('Please handle [PLX-HB] booking')).toEqual(['PLX-HB'])
    expect(extractTags('[PLX-HB] Hotel confirmation')).toEqual(['PLX-HB'])
    expect(extractTags('Hotel confirmation [PLX-HB]')).toEqual(['PLX-HB'])
  })

  it('extracts multiple distinct tags in order of appearance', () => {
    expect(extractTags('Re: [PLX-HB][PLX-CD] update for client')).toEqual(['PLX-HB', 'PLX-CD'])
    expect(extractTags('[PLX-TB] [PLX-VP] flight + visa')).toEqual(['PLX-TB', 'PLX-VP'])
  })

  it('returns empty array when no PLX tag is present', () => {
    expect(extractTags('Monthly newsletter March 2026')).toEqual([])
    expect(extractTags('Re: Your reservation at The Ritz')).toEqual([])
    expect(extractTags('')).toEqual([])
  })

  it('finds tags inside Re:/Fwd: prefixes', () => {
    expect(extractTags('Re: [PLX-VP] visa application update')).toEqual(['PLX-VP'])
    expect(extractTags('Fwd: Re: [PLX-HB] booking confirmation')).toEqual(['PLX-HB'])
    expect(extractTags('Re: Fwd: Re: [PLX-CD] client data')).toEqual(['PLX-CD'])
  })

  it('is case-insensitive for the tag code', () => {
    expect(extractTags('[plx-hb] booking')).toEqual(['PLX-HB'])
    expect(extractTags('[PLX-hb] booking')).toEqual(['PLX-HB'])
    expect(extractTags('[Plx-Hb] booking')).toEqual(['PLX-HB'])
  })

  it('deduplicates repeated identical tags', () => {
    expect(extractTags('[PLX-HB] Re: [PLX-HB] confirmation')).toEqual(['PLX-HB'])
    expect(extractTags('[PLX-HB][PLX-HB][PLX-HB]')).toEqual(['PLX-HB'])
  })

  it('ignores tags with unknown codes', () => {
    expect(extractTags('[PLX-XX] booking')).toEqual([])
    expect(extractTags('[PLX-ZZ] test')).toEqual([])
  })

  it('extracts all five valid tag codes', () => {
    expect(extractTags('[PLX-HB][PLX-TB][PLX-VP][PLX-OP][PLX-CD]'))
      .toEqual(['PLX-HB', 'PLX-TB', 'PLX-VP', 'PLX-OP', 'PLX-CD'])
  })

  it('does not match partial patterns (must be bracketed)', () => {
    expect(extractTags('PLX-HB booking without brackets')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// sectionsForTags
// ---------------------------------------------------------------------------

describe('sectionsForTags', () => {
  it('returns null for an empty tag array', () => {
    expect(sectionsForTags([])).toBeNull()
  })

  it('returns an empty Set for PLX-OP only (stub — no writes)', () => {
    const result = sectionsForTags(['PLX-OP'])
    expect(result).not.toBeNull()
    expect(result!.size).toBe(0)
  })

  it('returns correct sections for PLX-HB', () => {
    const result = sectionsForTags(['PLX-HB'])
    expect(result).not.toBeNull()
    expect(result!.has('bookings')).toBe(true)
    expect(result!.has('commissions')).toBe(true)
    expect(result!.has('pre_stay_tasks')).toBe(true)
    expect(result!.has('enquiries')).toBe(true)
    expect(result!.has('clients')).toBe(true)
    // Should NOT include flight or visa sections
    expect(result!.has('air_bookings')).toBe(false)
    expect(result!.has('visa_tracking')).toBe(false)
  })

  it('returns correct sections for PLX-TB', () => {
    const result = sectionsForTags(['PLX-TB'])
    expect(result).not.toBeNull()
    expect(result!.has('air_bookings')).toBe(true)
    expect(result!.has('airport_vip_services')).toBe(true)
    expect(result!.has('bookings')).toBe(false)
  })

  it('returns correct sections for PLX-VP', () => {
    const result = sectionsForTags(['PLX-VP'])
    expect(result).not.toBeNull()
    expect(result!.has('visa_tracking')).toBe(true)
    expect(result!.has('bookings')).toBe(false)
  })

  it('returns correct sections for PLX-CD', () => {
    const result = sectionsForTags(['PLX-CD'])
    expect(result).not.toBeNull()
    expect(result!.has('clients')).toBe(true)
    expect(result!.has('client_preferences')).toBe(true)
    expect(result!.has('client_health_notes')).toBe(true)
    expect(result!.has('bookings')).toBe(false)
  })

  it('returns the union of sections for multiple tags', () => {
    const result = sectionsForTags(['PLX-HB', 'PLX-TB'])
    expect(result).not.toBeNull()
    expect(result!.has('bookings')).toBe(true)
    expect(result!.has('air_bookings')).toBe(true)
    expect(result!.has('visa_tracking')).toBe(false)
  })

  it('PLX-OP mixed with other tags does not reduce sections (union)', () => {
    const result = sectionsForTags(['PLX-OP', 'PLX-HB'])
    expect(result).not.toBeNull()
    expect(result!.has('bookings')).toBe(true)
  })

  it('TAG_SECTIONS covers all expected entries', () => {
    expect(Object.keys(TAG_SECTIONS)).toEqual(
      expect.arrayContaining(['PLX-HB', 'PLX-TB', 'PLX-VP', 'PLX-OP', 'PLX-CD']),
    )
  })
})

// ---------------------------------------------------------------------------
// requiresExtraction
// ---------------------------------------------------------------------------

describe('requiresExtraction', () => {
  it('returns false for empty tag array', () => {
    expect(requiresExtraction([])).toBe(false)
  })

  it('returns false when only PLX-OP is present', () => {
    expect(requiresExtraction(['PLX-OP'])).toBe(false)
  })

  it('returns true for any non-OP tag', () => {
    expect(requiresExtraction(['PLX-HB'])).toBe(true)
    expect(requiresExtraction(['PLX-TB'])).toBe(true)
    expect(requiresExtraction(['PLX-VP'])).toBe(true)
    expect(requiresExtraction(['PLX-CD'])).toBe(true)
  })

  it('returns true when PLX-OP is mixed with other tags', () => {
    expect(requiresExtraction(['PLX-OP', 'PLX-HB'])).toBe(true)
    expect(requiresExtraction(['PLX-HB', 'PLX-OP'])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// matchGdsWhitelist
// ---------------------------------------------------------------------------

describe('matchGdsWhitelist', () => {
  it('matches LHW sender exactly — no attachment required', () => {
    const r = matchGdsWhitelist('reservations.singapore@lhw.com', false)
    expect(r.matched).toBe(true)
    expect(r.source).toBe('lhw')
  })

  it('matches LHW regardless of attachment presence', () => {
    expect(matchGdsWhitelist('reservations.singapore@lhw.com', true).matched).toBe(true)
    expect(matchGdsWhitelist('reservations.singapore@lhw.com', false).matched).toBe(true)
  })

  it('matches Amadeus/KFT sender WITH confirmation attachment', () => {
    const r = matchGdsWhitelist('info@kft.travel', true)
    expect(r.matched).toBe(true)
    expect(r.source).toBe('amadeus')
  })

  it('rejects Amadeus/KFT sender WITHOUT confirmation attachment (falls through to tag flow)', () => {
    const r = matchGdsWhitelist('info@kft.travel', false)
    expect(r.matched).toBe(false)
  })

  it('rejects an unknown sender regardless of attachment', () => {
    expect(matchGdsWhitelist('random@hotel.com', true).matched).toBe(false)
    expect(matchGdsWhitelist('random@hotel.com', false).matched).toBe(false)
  })

  it('is case-insensitive on the email address', () => {
    expect(matchGdsWhitelist('Reservations.Singapore@LHW.com', false).matched).toBe(true)
    expect(matchGdsWhitelist('INFO@KFT.TRAVEL', true).matched).toBe(true)
  })

  it('does not match a subdomain of a whitelisted domain', () => {
    expect(matchGdsWhitelist('noreply@lhw.com', false).matched).toBe(false)
    expect(matchGdsWhitelist('info@mail.kft.travel', true).matched).toBe(false)
  })
})
