// Tool definitions + executors for the unified Trainer Chat agent
// (lib/trainer/agent.ts). Read tools answer questions ("list the Jain
// family"); write tools take direction ("group people based on that") —
// both reuse the same routing/gap-detection logic the earlier family-tabs
// flow used, just exposed as Claude tool calls instead of a fixed question
// queue.

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../supabase'
import { isValidClientName, normalizeName } from '../resolvers'
import { removeFamilyMember } from '../studio/queries'
import { buildInterviewQueue, checkFamilySplit } from './gaps'
import { routeExtractedFact, describeRoutingResult, type ExtractedFact, type ClientFieldName } from './routing'
import type { FamilyMemberRole } from '../studio/types'

// ----------------------------------------------------------------
// Tool schemas — Anthropic tool-use format
// ----------------------------------------------------------------

const CLIENT_FIELDS: ClientFieldName[] = [
  'full_name', 'email', 'phone', 'whatsapp', 'title', 'first_name', 'last_name',
  'nationality', 'city_of_residence', 'company', 'birthday', 'anniversary',
]
const RELATIONSHIP_TYPES: FamilyMemberRole[] = [
  'primary', 'spouse', 'parent', 'child', 'sibling', 'business_partner', 'member',
]

export const TRAINER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_clients',
    description: 'Search client records by name (substring match, case-insensitive). Use this to find people before looking up or writing anything — never guess a client exists.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name or partial name to search for' } },
      required: ['query'],
    },
  },
  {
    name: 'get_family_priority_queue',
    description: 'Returns the Session 1 family-priority worklist (Patni, Choksey, Jain, Agarwal) with how many client records exist and how many are still unlinked for each. Use when asked what to work on, or for overall progress.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_family_gaps',
    description: 'For a surname, lists every matching client record, which already have a confirmed family link, which don\'t, and any records flagged for re-verification. This is the ground truth for "list the X family" or "who\'s missing from Y" type requests.',
    input_schema: {
      type: 'object',
      properties: { surname: { type: 'string', description: 'Surname to look up, e.g. "Jain"' } },
      required: ['surname'],
    },
  },
  {
    name: 'get_family_members',
    description: 'Given a client\'s name, returns their family record and every member currently linked to it with their role. Use to check "who is X related to" or before deciding how to link someone.',
    input_schema: {
      type: 'object',
      properties: { client_name: { type: 'string' } },
      required: ['client_name'],
    },
  },
  {
    name: 'get_client_details',
    description: 'Full profile for one client: contact info, notes, saved preferences, and family link. Use before answering detailed questions about a specific person.',
    input_schema: {
      type: 'object',
      properties: { client_name: { type: 'string' } },
      required: ['client_name'],
    },
  },
  {
    name: 'link_family_member',
    description: 'Links two people as family members with a stated relationship. Only call this when the team member has told you (directly or by confirming your suggestion) that these two people are actually related — never link based on a surname match alone.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'The person whose role is being set' },
        related_client_name: { type: 'string', description: 'The person they are related to' },
        relationship_type: { type: 'string', enum: RELATIONSHIP_TYPES, description: 'What client_name IS to related_client_name, e.g. client_name is the "child" of related_client_name' },
        family_name: { type: 'string', description: 'Optional label for a brand-new family record if neither person has one yet' },
      },
      required: ['client_name', 'related_client_name', 'relationship_type'],
    },
  },
  {
    name: 'unlink_family_member',
    description: 'Removes a client from whichever family they\'re currently linked to. Use to undo a mistaken link the team member points out.',
    input_schema: {
      type: 'object',
      properties: { client_name: { type: 'string' } },
      required: ['client_name'],
    },
  },
  {
    name: 'update_client_field',
    description: 'Sets a single hard field (email, phone, nationality, etc.) on a client record.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        field: { type: 'string', enum: CLIENT_FIELDS },
        value: { type: 'string' },
      },
      required: ['client_name', 'field', 'value'],
    },
  },
  {
    name: 'save_preference',
    description: 'Saves a travel/service preference for a client (room type, dietary, seating, property brand, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        category: { type: 'string' },
        preference: { type: 'string' },
        preference_type: { type: 'string', enum: ['like', 'dislike', 'requirement'] },
      },
      required: ['client_name', 'category', 'preference'],
    },
  },
  {
    name: 'save_passport_number',
    description: 'Records a passport number mentioned in conversation (no scan attached — a real passport upload is a separate flow).',
    input_schema: {
      type: 'object',
      properties: { client_name: { type: 'string' }, passport_number: { type: 'string' } },
      required: ['client_name', 'passport_number'],
    },
  },
  {
    name: 'save_note',
    description: 'Saves a freeform fact that doesn\'t fit a structured field — a duplicate-record flag, a data-quality issue, a habit or warning about a client, general context. If unsure where something goes, this is the safe default.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Optional — omit if the note is not about one specific client' },
        content: { type: 'string' },
      },
      required: ['content'],
    },
  },
]

// ----------------------------------------------------------------
// Executors — one per tool name, called from agent.ts with parsed input
// ----------------------------------------------------------------

export interface ToolContext {
  created_by: string
}

async function execSearchClients(input: { query: string }) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, full_name, email, phone, normalized_name')
    .ilike('normalized_name', `%${input.query.toLowerCase()}%`)
    .limit(30)
  if (error) throw new Error(`search_clients: ${error.message}`)
  if (!data?.length) return { matches: [], note: 'No clients found matching that query.' }

  const ids = data.map(c => c.id)
  const { data: memberships, error: mErr } = await supabase
    .from('family_members').select('client_id, family_id, role').in('client_id', ids)
  if (mErr) throw new Error(`search_clients family_members: ${mErr.message}`)
  const linked = new Map((memberships ?? []).map(m => [m.client_id, m]))

  return {
    matches: data.map(c => ({
      id: c.id,
      full_name: c.full_name,
      email: c.email,
      phone: c.phone,
      linked: linked.has(c.id),
      role: linked.get(c.id)?.role ?? null,
    })),
  }
}

async function execFamilyPriorityQueue() {
  const FAMILY_PRIORITY = ['Patni', 'Choksey', 'Jain', 'Agarwal']
  const families = await Promise.all(FAMILY_PRIORITY.map(async name => {
    const result = await buildInterviewQueue(name)
    if ('disambiguation' in result) {
      return { name, disambiguation: true, clusters: result.clusters }
    }
    if (!result.matched_client_ids.length) {
      return { name, total_clients: 0, linked_count: 0, unlinked_count: 0 }
    }
    // Explicit linked count, not left for the model to infer from
    // remaining_gaps alone — see list_family_gaps for why that matters.
    const { data: memberships, error } = await supabase
      .from('family_members').select('client_id').in('client_id', result.matched_client_ids)
    if (error) throw new Error(`get_family_priority_queue memberships: ${error.message}`)
    const linkedCount = new Set((memberships ?? []).map(m => m.client_id)).size
    return {
      name,
      total_clients: result.matched_client_ids.length,
      linked_count: linkedCount,
      unlinked_count: result.matched_client_ids.length - linkedCount,
    }
  }))
  return { families }
}

async function execListFamilyGaps(input: { surname: string }) {
  const result = await buildInterviewQueue(input.surname)
  if ('disambiguation' in result) {
    return {
      disambiguation: true,
      message: `More than one "${input.surname}" family already exists on file.`,
      clusters: result.clusters,
    }
  }
  if (!result.matched_client_ids.length) {
    return { matches: [], note: `No clients found matching "${input.surname}".` }
  }

  // buildInterviewQueue's `questions` only covers gaps (unlinked/flagged) —
  // it never states who's ALREADY linked. A live check showed the model
  // guessing "0 linked" / "all unlinked" from that omission and being
  // flatly wrong (4 of 25 Jain clients were already linked). Compute the
  // linked/unlinked split explicitly here so it's never inferred.
  const { data: memberships, error } = await supabase
    .from('family_members')
    .select('client_id, role, family:families(family_name)')
    .in('client_id', result.matched_client_ids)
  if (error) throw new Error(`list_family_gaps memberships: ${error.message}`)

  const nameById = new Map(result.matched_client_ids.map((id, i) => [id, result.matched_client_names[i]]))
  const linked = (memberships ?? []).map((m: any) => ({
    client: nameById.get(m.client_id),
    role: m.role,
    family_name: m.family?.family_name ?? null,
  }))

  return {
    total_clients: result.matched_client_ids.length,
    linked_count: linked.length,
    unlinked_count: result.matched_client_ids.length - linked.length,
    already_linked: linked,
    all_clients: result.matched_client_names,
    gaps: result.questions
      .filter(q => q.reason !== 'catch_all')
      .map(q => ({ client: q.client_name, reason: q.reason, detail: q.prompt })),
  }
}

async function execGetFamilyMembers(input: { client_name: string }) {
  if (!isValidClientName(input.client_name)) return { error: `"${input.client_name}" isn't a valid single-person name.` }
  const normalized = normalizeName(input.client_name)
  const { data: client, error: cErr } = await supabase
    .from('clients').select('id, full_name').eq('normalized_name', normalized).maybeSingle()
  if (cErr) throw new Error(`get_family_members client lookup: ${cErr.message}`)
  if (!client) return { error: `No client found named "${input.client_name}".` }

  const { data: membership, error: mErr } = await supabase
    .from('family_members').select('family_id, role, family:families(family_name)')
    .eq('client_id', client.id).maybeSingle()
  if (mErr) throw new Error(`get_family_members membership: ${mErr.message}`)
  if (!membership) return { client: client.full_name, family: null, members: [] }

  const { data: members, error: memErr } = await supabase
    .from('family_members').select('role, client:clients(id, full_name)')
    .eq('family_id', membership.family_id)
  if (memErr) throw new Error(`get_family_members members: ${memErr.message}`)

  return {
    client: client.full_name,
    family_name: (membership.family as any)?.family_name ?? null,
    members: (members ?? []).map((m: any) => ({ name: m.client?.full_name, role: m.role })),
  }
}

async function execGetClientDetails(input: { client_name: string }) {
  if (!isValidClientName(input.client_name)) return { error: `"${input.client_name}" isn't a valid single-person name.` }
  const normalized = normalizeName(input.client_name)
  const { data: client, error } = await supabase
    .from('clients').select('*').eq('normalized_name', normalized).maybeSingle()
  if (error) throw new Error(`get_client_details: ${error.message}`)
  if (!client) return { error: `No client found named "${input.client_name}".` }

  const { data: prefs } = await supabase
    .from('client_preferences').select('category, preference, preference_type').eq('client_id', client.id)
  const { data: notes } = await supabase
    .from('knowledge_chunks').select('content').eq('client_id', client.id).order('created_at', { ascending: false }).limit(10)

  return {
    full_name: client.full_name,
    email: client.email,
    phone: client.phone,
    nationality: client.nationality,
    vip_level: client.vip_level,
    general_notes: client.general_notes,
    misc: client.misc,
    preferences: prefs ?? [],
    notes: (notes ?? []).map(n => n.content),
  }
}

async function execUnlinkFamilyMember(input: { client_name: string }) {
  if (!isValidClientName(input.client_name)) return { error: `"${input.client_name}" isn't a valid single-person name.` }
  const normalized = normalizeName(input.client_name)
  const { data: client, error: cErr } = await supabase
    .from('clients').select('id, full_name').eq('normalized_name', normalized).maybeSingle()
  if (cErr) throw new Error(`unlink_family_member client lookup: ${cErr.message}`)
  if (!client) return { error: `No client found named "${input.client_name}".` }

  const { data: membership, error: mErr } = await supabase
    .from('family_members').select('family_id').eq('client_id', client.id).maybeSingle()
  if (mErr) throw new Error(`unlink_family_member membership: ${mErr.message}`)
  if (!membership) return { message: `${client.full_name} wasn't linked to any family.` }

  await removeFamilyMember(membership.family_id, client.id)
  return { message: `Unlinked ${client.full_name} from their family.` }
}

// ----------------------------------------------------------------
// executeTool — dispatch by name, called from the agent loop
// ----------------------------------------------------------------

export async function executeTool(
  name: string,
  input: any,
  ctx: ToolContext,
): Promise<{ output: unknown; confirmation?: string }> {
  switch (name) {
    case 'search_clients':
      return { output: await execSearchClients(input) }
    case 'get_family_priority_queue':
      return { output: await execFamilyPriorityQueue() }
    case 'list_family_gaps':
      return { output: await execListFamilyGaps(input) }
    case 'get_family_members':
      return { output: await execGetFamilyMembers(input) }
    case 'get_client_details':
      return { output: await execGetClientDetails(input) }
    case 'unlink_family_member':
      return { output: await execUnlinkFamilyMember(input) }

    case 'link_family_member': {
      const fact: ExtractedFact = {
        kind: 'relationship',
        client_ref: input.client_name,
        related_client_ref: input.related_client_name,
        relationship_type: input.relationship_type,
        family_name: input.family_name,
      }
      const result = await routeExtractedFact(fact, { source_type: 'interview', created_by: ctx.created_by })
      return { output: result, confirmation: describeRoutingResult(fact, result) }
    }

    case 'update_client_field': {
      const fact: ExtractedFact = { kind: 'client_field', client_ref: input.client_name, field: input.field, value: input.value }
      const result = await routeExtractedFact(fact, { source_type: 'interview', created_by: ctx.created_by })
      return { output: result, confirmation: describeRoutingResult(fact, result) }
    }

    case 'save_preference': {
      const fact: ExtractedFact = {
        kind: 'preference', client_ref: input.client_name, category: input.category,
        preference: input.preference, preference_type: input.preference_type,
      }
      const result = await routeExtractedFact(fact, { source_type: 'interview', created_by: ctx.created_by })
      return { output: result, confirmation: describeRoutingResult(fact, result) }
    }

    case 'save_passport_number': {
      const fact: ExtractedFact = { kind: 'passport_number', client_ref: input.client_name, passport_number: input.passport_number }
      const result = await routeExtractedFact(fact, { source_type: 'interview', created_by: ctx.created_by })
      return { output: result, confirmation: describeRoutingResult(fact, result) }
    }

    case 'save_note': {
      const fact: ExtractedFact = { kind: 'narrative', client_ref: input.client_name, content: input.content }
      const result = await routeExtractedFact(fact, { source_type: 'interview', created_by: ctx.created_by })
      return { output: result, confirmation: describeRoutingResult(fact, result) }
    }

    default:
      return { output: { error: `Unknown tool "${name}"` } }
  }
}

// Re-exported so the agent's system prompt can mention the family-split
// check without duplicating the query.
export { checkFamilySplit }
