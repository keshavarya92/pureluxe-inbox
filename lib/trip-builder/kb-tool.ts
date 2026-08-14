// KB suggestion tool for Trip Builder itinerary content. Queries
// destination_facts/property_facts first; if neither has anything for the
// requested destination/property, falls back to general LLM knowledge.
// Every result carries which path produced it (source: 'kb' | 'llm_general')
// — this is set here, at the point of generation, and never inferred
// downstream, per the provenance-flagging requirement in the build brief.
//
// Exposed in Anthropic tool-use format (TRIP_BUILDER_KB_TOOLS + executeKBTool)
// so the future chat backend (build order step 5) can wire it into its
// tool-calling loop the same way lib/trainer/tools.ts does today. Not wired
// into anything yet — this module is standalone.

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../supabase'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY environment variable')
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type SuggestionCategory = 'dining' | 'activities' | 'general'

export interface KBSuggestionInput {
  destination:     string
  property_name?:  string | null
  category?:       SuggestionCategory
}

export interface KBSuggestionResult {
  source:        'kb' | 'llm_general'
  destination:   string
  property_name: string | null
  content:       string
}

async function lookupDestinationFacts(destination: string) {
  const { data, error } = await supabase
    .from('destination_facts')
    .select('dining_recs, activities, notes')
    .ilike('destination', `%${destination}%`)
    .order('updated_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`suggest_itinerary_content destination_facts lookup: ${error.message}`)
  return data?.[0] ?? null
}

// Property names collide across brands with multiple luxury properties
// (Six Senses, Soneva, ...) — matching on property_name alone can return a
// confident-looking 'kb' hit for the WRONG property. Scoping by destination
// too doesn't guarantee a correct match, but it rules out the common case
// (same brand, different country) cheaply. A property_facts row with no
// destination on file (nullable in the schema) can't be confirmed as the
// right property, so it's treated as a non-match here rather than guessed —
// an honest llm_general fallback beats a mismatched 'kb' tag.
async function lookupPropertyFacts(propertyName: string, destination: string) {
  const { data, error } = await supabase
    .from('property_facts')
    .select('dining_recs, notes')
    .ilike('property_name', `%${propertyName}%`)
    .ilike('destination', `%${destination}%`)
    .order('updated_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`suggest_itinerary_content property_facts lookup: ${error.message}`)
  return data?.[0] ?? null
}

async function generateGeneralSuggestion(
  destination:  string,
  propertyName: string | null,
  category:     SuggestionCategory,
): Promise<string> {
  const topic =
    category === 'dining'     ? 'dining and restaurant recommendations' :
    category === 'activities' ? 'activities and experiences' :
    'dining, activities, and general travel notes'
  const where = propertyName ? `${destination}, staying at ${propertyName}` : destination

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are a luxury travel advisor\'s assistant helping build a client itinerary. Give specific, concrete, luxury-oriented recommendations — named restaurants and experiences with detail, not generic filler. Keep it to a few short paragraphs or a tight list.',
    messages: [{
      role: 'user',
      content: `Suggest ${topic} for a trip to ${where}. This is general knowledge, not sourced from our internal knowledge base — note anything you're unsure is still current.`,
    }],
  })

  return response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim()
}

export async function getKBSuggestion(input: KBSuggestionInput): Promise<KBSuggestionResult> {
  const category = input.category ?? 'general'
  const propertyName = input.property_name ?? null

  const [destFacts, propFacts] = await Promise.all([
    lookupDestinationFacts(input.destination),
    propertyName ? lookupPropertyFacts(propertyName, input.destination) : Promise.resolve(null),
  ])

  // A matched row with nothing in the field this category asks for is
  // functionally the same as no KB entry — each push below is guarded by
  // the specific field's truthiness, never by "a row matched at all", so
  // an empty/null field always falls through to the llm_general path.
  const kbParts: string[] = []
  if (category === 'dining' || category === 'general') {
    if (propFacts?.dining_recs) kbParts.push(propFacts.dining_recs)
    if (destFacts?.dining_recs) kbParts.push(destFacts.dining_recs)
  }
  if (category === 'activities' || category === 'general') {
    if (destFacts?.activities) kbParts.push(destFacts.activities)
  }
  if (category === 'general') {
    if (propFacts?.notes) kbParts.push(propFacts.notes)
    if (destFacts?.notes) kbParts.push(destFacts.notes)
  }

  if (kbParts.length) {
    return {
      source:        'kb',
      destination:   input.destination,
      property_name: propertyName,
      content:       kbParts.join('\n\n'),
    }
  }

  const content = await generateGeneralSuggestion(input.destination, propertyName, category)
  return {
    source:        'llm_general',
    destination:   input.destination,
    property_name: propertyName,
    content,
  }
}

// ----------------------------------------------------------------
// Tool schema — Anthropic tool-use format, for step 5's chat backend
// ----------------------------------------------------------------

export const TRIP_BUILDER_KB_TOOLS: Anthropic.Tool[] = [
  {
    name: 'suggest_itinerary_content',
    description: 'Looks up dining/activity/notes suggestions for a destination (and optionally a specific property) from the internal knowledge base first; falls back to general travel knowledge if nothing is on file. The response always states which source was used — never assume it\'s grounded without checking.',
    input_schema: {
      type: 'object',
      properties: {
        destination:   { type: 'string', description: 'Destination name, e.g. "Maldives"' },
        property_name: { type: 'string', description: 'Optional specific property/hotel name' },
        category:      { type: 'string', enum: ['dining', 'activities', 'general'], description: 'What kind of suggestion to return; defaults to general' },
      },
      required: ['destination'],
    },
  },
]

export async function executeKBTool(name: string, input: any): Promise<{ output: unknown }> {
  switch (name) {
    case 'suggest_itinerary_content':
      return { output: await getKBSuggestion(input) }
    default:
      return { output: { error: `Unknown tool "${name}"` } }
  }
}
