/**
 * Subject-line tag extraction and per-tag section routing.
 *
 * Tags follow the format [PLX-XX] (case-insensitive) anywhere in subject,
 * including after Re:/Fwd: prefixes.
 */

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

const TAG_RE = /\[PLX-(HB|TB|VP|OP|CD)\]/gi

/** Extract all unique PLX tags from a subject line, normalized to uppercase. */
export function extractTags(subject: string): string[] {
  const seen  = new Set<string>()
  const tags: string[] = []
  // Fresh regex each call — avoids lastIndex state pollution with /g flag.
  const re = new RegExp(TAG_RE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(subject)) !== null) {
    const tag = `PLX-${m[1].toUpperCase()}`
    if (!seen.has(tag)) { seen.add(tag); tags.push(tag) }
  }
  return tags
}

// ---------------------------------------------------------------------------
// Section routing
// ---------------------------------------------------------------------------

/**
 * Maps each PLX tag to the writeExtracted section names it enables.
 * GDS/whitelist emails always receive activeSections = undefined (all sections).
 */
export const TAG_SECTIONS: Record<string, readonly string[]> = {
  'PLX-HB': [
    'bookings', 'commissions', 'pre_stay_tasks', 'enquiries',
    'clients', 'client_preferences', 'property_contacts', 'properties',
  ],
  'PLX-TB': ['air_bookings', 'airport_vip_services'],
  'PLX-VP': ['visa_tracking', 'clients'],
  'PLX-CD': ['clients', 'client_preferences', 'client_health_notes', 'property_contacts'],
  'PLX-OP': [], // operations stub — log only, no LLM extraction
}

/**
 * Compute the active writeExtracted sections for a tag set.
 * Returns:
 *   null      — no tags (caller decides; GDS uses activeSections = undefined)
 *   empty Set — only PLX-OP present (skip extraction entirely, log only)
 *   Set<>     — sections to pass to writeExtracted
 */
export function sectionsForTags(tags: string[]): Set<string> | null {
  if (tags.length === 0) return null
  const sections = new Set<string>()
  for (const tag of tags) {
    for (const s of TAG_SECTIONS[tag] ?? []) sections.add(s)
  }
  return sections
}

/**
 * Returns true when at least one tag requires LLM extraction
 * (i.e. not all tags are PLX-OP).
 */
export function requiresExtraction(tags: string[]): boolean {
  return tags.some(t => t !== 'PLX-OP')
}
