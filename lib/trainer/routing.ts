// Shared extraction routing — AGENTS.md Section 4.
// Both /api/trainer/dump/confirm and /api/trainer/interview/answer call
// routeExtractedFact() for each fact so the hard-field-vs-narrative split
// lives in one place. Extraction (the LLM call) decides *what* the facts
// are; this module decides *where they land*.

import { supabase } from '../supabase'
import { resolveClient, isValidClientName, normalizeName, type ClientInput } from '../resolvers'
import { createFamily, addFamilyMember, removeFamilyMember } from '../studio/queries'
import type { FamilyMemberRole } from '../studio/types'

// ----------------------------------------------------------------
// ExtractedFact — the shared input shape
// ----------------------------------------------------------------

// Hard fields: hold a client_ref (name as extracted from source text —
// routeExtractedFact resolves this to a client_id via resolveClient()).
export type ClientFieldName =
  | 'full_name' | 'email' | 'phone' | 'whatsapp' | 'title' | 'first_name' | 'last_name'
  | 'nationality' | 'city_of_residence' | 'company' | 'birthday' | 'anniversary'

export interface ClientFieldFact {
  kind: 'client_field'
  client_ref: string
  field: ClientFieldName
  value: string
}

export interface RelationshipFact {
  kind: 'relationship'
  client_ref: string
  related_client_ref: string
  relationship_type: FamilyMemberRole
  // Explicit family name to file under, e.g. "Patni". Falls back to a
  // surname guess from client_ref when omitted.
  family_name?: string
}

export interface PreferenceFact {
  kind: 'preference'
  client_ref: string
  category: string
  preference: string
  preference_type?: 'like' | 'dislike' | 'requirement'
}

// A bare passport-number mention from text (no scan attached — that flow
// is Section 5's dedicated upload/OCR/approve path, which writes
// client_documents directly and never goes through this router). There's
// no dedicated clients column for this, so it's appended to clients.misc,
// same pattern as the general_notes/internal_notes append in resolvers.ts.
export interface PassportNumberFact {
  kind: 'passport_number'
  client_ref: string
  passport_number: string
}

export interface NarrativeFact {
  kind: 'narrative'
  client_ref?: string
  destination?: string
  property?: string
  content: string
}

export type ExtractedFact =
  | ClientFieldFact
  | RelationshipFact
  | PreferenceFact
  | PassportNumberFact
  | NarrativeFact

export interface RoutingContext {
  source_type: 'dump' | 'interview' | 'whatsapp' | 'itinerary' | 'note'
  created_by: string // team member email
}

export interface FamilyConflict {
  family_ids: string[]
  family_names: string[]
  message: string
}

export type RoutingResult =
  | { target: 'clients'; client_id: string }
  | {
      target: 'family_members'
      written: boolean // false when a conflict blocked the write — see `conflict`
      client_id: string
      related_client_id: string
      family_id: string | null
      conflict?: FamilyConflict
    }
  | { target: 'client_preferences'; client_id: string; id: string }
  | { target: 'knowledge_chunks'; client_id: string | null; id: string }
  | { target: 'skipped'; reason: string }

// ----------------------------------------------------------------
// Read-only client lookup — used for narrative tagging, where a fact
// should be tagged with an existing client if one matches but must NOT
// create a new client just to attach a knowledge_chunks tag (Section 4:
// "tagged with client_id if resolved, else null").
// ----------------------------------------------------------------

async function lookupClientId(name: string | undefined): Promise<string | null> {
  if (!name || !isValidClientName(name)) return null
  const normalized = normalizeName(name)
  const { data } = await supabase
    .from('clients')
    .select('id')
    .eq('normalized_name', normalized)
    .limit(1)
  return data?.[0]?.id ?? null
}

// ----------------------------------------------------------------
// Family resolution — find-or-create by surname, reusing whichever
// family either side of the relationship already belongs to.
// ----------------------------------------------------------------

function guessSurname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/)
  return parts[parts.length - 1] ?? fullName
}

// Reciprocal role for the *related* side of a relationship fact.
// Symmetric relationships (spouse/sibling/business_partner/primary/member)
// mirror the same role on both sides. parent/child invert. There's no
// inverse for a role not in this map (spouse, sibling, ...) — those mirror.
const INVERSE_ROLE: Partial<Record<FamilyMemberRole, FamilyMemberRole>> = {
  parent: 'child',
  child: 'parent',
}

function reciprocalRole(role: FamilyMemberRole): FamilyMemberRole {
  return INVERSE_ROLE[role] ?? role
}

// family_members.role is a single column — a person who is BOTH "spouse of
// X" (from one fact) and "parent of Y" (from another) can only keep one of
// those. The direct/explicit side of a fact always writes (a stated role is
// trustworthy); the reciprocal/inferred side only writes if the person has
// no row yet, so a later explicit statement about someone is never clobbered
// by an earlier guess. Known limitation: if the earlier fact was also
// explicit (that person was the direct client_ref elsewhere), this still
// can't represent both roles — the schema only holds one.
async function addReciprocalMember(
  familyId: string,
  clientId: string,
  role: FamilyMemberRole,
): Promise<void> {
  const { data: existing, error } = await supabase
    .from('family_members')
    .select('id')
    .eq('family_id', familyId)
    .eq('client_id', clientId)
    .maybeSingle()
  if (error) throw new Error(`addReciprocalMember lookup: ${error.message}`)
  if (existing) return
  await addFamilyMember(familyId, clientId, role, false)
}

async function resolveFamilyForRelationship(
  clientAId: string,
  clientBId: string,
  familyNameHint: string,
  createdBy: string,
): Promise<{ family_id: string | null; conflict?: FamilyConflict }> {
  const { data: existingMemberships, error: memErr } = await supabase
    .from('family_members')
    .select('family_id, client_id')
    .in('client_id', [clientAId, clientBId])
  if (memErr) throw new Error(`resolveFamilyForRelationship family_members lookup: ${memErr.message}`)

  const familyIds = [...new Set((existingMemberships ?? []).map(m => m.family_id))]

  if (familyIds.length === 1) return { family_id: familyIds[0] }

  if (familyIds.length > 1) {
    // Both sides already belong to different families — a real conflict,
    // possibly two branches that should be merged, or two unrelated
    // households sharing a surname. Don't guess: skip the write (family_id
    // null, caller does not link) and surface it for a human to pick,
    // same philosophy as client_dedup_flags — never auto-merge.
    const { data: families, error: famErr } = await supabase
      .from('families')
      .select('id, family_name')
      .in('id', familyIds)
    if (famErr) throw new Error(`resolveFamilyForRelationship families lookup: ${famErr.message}`)
    const familyNames = (families ?? []).map(f => f.family_name)
    const message = `These two people already belong to different families (${familyNames.join(' vs. ')}) — pick one to link them under instead of merging automatically.`
    console.warn(`[trainer/routing] relationship spans families ${familyIds.join(',')} for clients ${clientAId}/${clientBId} — write skipped, needs manual pick`)
    return { family_id: null, conflict: { family_ids: familyIds, family_names: familyNames, message } }
  }

  // Neither side has a family yet. Deliberately NOT doing surname/name
  // matching against unrelated existing families here — a shared surname
  // is not proof of relation (the entire premise of this cleanup session:
  // 14 "Patni" clients on file may be several unrelated households). The
  // only trustworthy reuse signal is an actual family_members link,
  // handled above. Always create a new family; if it turns out to
  // duplicate an existing household under a different name, that's a
  // family-list merge for a human to do later, not something to guess here.
  const created = await createFamily(familyNameHint, createdBy)
  return { family_id: created.id }
}

// ----------------------------------------------------------------
// routeExtractedFact — the shared write path
// ----------------------------------------------------------------

export async function routeExtractedFact(
  fact: ExtractedFact,
  ctx: RoutingContext,
): Promise<RoutingResult> {
  switch (fact.kind) {
    case 'client_field': {
      if (!isValidClientName(fact.client_ref)) {
        return { target: 'skipped', reason: `invalid client name "${fact.client_ref}"` }
      }
      const input: ClientInput = { full_name: fact.client_ref, [fact.field]: fact.value } as ClientInput
      const clientId = await resolveClient(input)
      return { target: 'clients', client_id: clientId }
    }

    case 'relationship': {
      if (!isValidClientName(fact.client_ref) || !isValidClientName(fact.related_client_ref)) {
        return { target: 'skipped', reason: 'invalid client name in relationship fact' }
      }
      const [clientId, relatedId] = await Promise.all([
        resolveClient({ full_name: fact.client_ref }),
        resolveClient({ full_name: fact.related_client_ref }),
      ])
      const familyNameHint = fact.family_name ?? guessSurname(fact.client_ref)
      const { family_id: familyId, conflict } = await resolveFamilyForRelationship(clientId, relatedId, familyNameHint, ctx.created_by)

      if (conflict || !familyId) {
        return {
          target: 'family_members',
          written: false,
          client_id: clientId,
          related_client_id: relatedId,
          family_id: null,
          conflict,
        }
      }

      await addFamilyMember(familyId, clientId, fact.relationship_type, false)
      try {
        // Reciprocal link — mirrors symmetric roles (spouse/sibling/...) or
        // inverts parent<->child. Only writes if related person has no role
        // yet in this family — see addReciprocalMember's doc comment for why.
        await addReciprocalMember(familyId, relatedId, reciprocalRole(fact.relationship_type))
      } catch (err) {
        // Compensating rollback — a one-sided family link (client linked,
        // related person not) is worse than no link at all, since it reads
        // as confirmed data. addFamilyMember/removeFamilyMember both throw
        // on {error}, so this only reaches here on a real DB failure.
        await removeFamilyMember(familyId, clientId).catch(rollbackErr =>
          console.error(`[trainer/routing] compensating rollback failed family_id=${familyId} client_id=${clientId}:`, rollbackErr),
        )
        throw err
      }

      return { target: 'family_members', written: true, client_id: clientId, related_client_id: relatedId, family_id: familyId }
    }

    case 'preference': {
      if (!isValidClientName(fact.client_ref)) {
        return { target: 'skipped', reason: `invalid client name "${fact.client_ref}"` }
      }
      const clientId = await resolveClient({ full_name: fact.client_ref })
      const { data, error } = await supabase
        .from('client_preferences')
        .insert({
          client_id: clientId,
          category: fact.category,
          preference: fact.preference,
          preference_type: fact.preference_type ?? 'like',
          source: ctx.source_type,
        })
        .select('id')
        .single()
      if (error) throw new Error(`routeExtractedFact preference insert: ${error.message}`)
      return { target: 'client_preferences', client_id: clientId, id: data.id }
    }

    case 'passport_number': {
      if (!isValidClientName(fact.client_ref)) {
        return { target: 'skipped', reason: `invalid client name "${fact.client_ref}"` }
      }
      const clientId = await resolveClient({ full_name: fact.client_ref })
      const note = `Passport number (reported, no scan on file): ${fact.passport_number}`
      const { data: existing, error: fetchErr } = await supabase
        .from('clients').select('misc').eq('id', clientId).single()
      if (fetchErr) throw new Error(`routeExtractedFact passport_number fetch: ${fetchErr.message}`)
      const existingMisc = (existing?.misc as string | null) ?? ''
      if (!existingMisc.includes(note)) {
        const { error: updateErr } = await supabase
          .from('clients')
          .update({ misc: existingMisc ? `${existingMisc}\n${note}` : note })
          .eq('id', clientId)
        if (updateErr) throw new Error(`routeExtractedFact passport_number update: ${updateErr.message}`)
      }
      return { target: 'clients', client_id: clientId }
    }

    case 'narrative': {
      const clientId = await lookupClientId(fact.client_ref)
      const embedding = await embedContent(fact.content)
      const { data, error } = await supabase
        .from('knowledge_chunks')
        .insert({
          source_type: ctx.source_type,
          client_id:   clientId,
          destination: fact.destination ?? null,
          property:    fact.property ?? null,
          content:     fact.content,
          embedding,
          created_by:  ctx.created_by,
        })
        .select('id')
        .single()
      if (error) throw new Error(`routeExtractedFact narrative insert: ${error.message}`)
      return { target: 'knowledge_chunks', client_id: clientId, id: data.id }
    }
  }
}

// ----------------------------------------------------------------
// embedContent — TODO: no embeddings provider is configured yet
// (ANTHROPIC_API_KEY doesn't serve embeddings). knowledge_chunks.embedding
// is vector(1536), matching either OpenAI text-embedding-3-small or
// Voyage voyage-large-2 — pick one and wire the real call here before
// Trainer Chat goes live. Until then, chunks are written with a null
// embedding (content is still saved and readable, just not vector-searchable).
// ----------------------------------------------------------------

async function embedContent(_content: string): Promise<number[] | null> {
  return null
}

// ----------------------------------------------------------------
// describeRoutingResult — short inline feedback for chat UIs
// ("got it — linked as family member"). Shared by both dump/confirm and
// interview/answer so the phrasing stays consistent across entry points.
// Conflicts are called out explicitly, not folded into a generic
// "skipped" message — the team member needs to see the pick-one decision.
// ----------------------------------------------------------------

const ROLE_LABEL: Record<FamilyMemberRole, string> = {
  primary: 'primary contact', spouse: 'spouse', parent: 'parent',
  child: 'child', sibling: 'sibling', business_partner: 'business partner', member: 'member',
}

// Takes the original fact alongside the result so the message can name
// names, not just say "linked as family member" — a live session showed
// that generic phrasing left the team member with no way to tell what was
// actually written without opening Supabase directly.
export function describeRoutingResult(fact: ExtractedFact, result: RoutingResult): string {
  switch (result.target) {
    case 'clients':
      if (fact.kind === 'client_field') return `Set ${fact.client_ref}'s ${fact.field} to "${fact.value}"`
      if (fact.kind === 'passport_number') return `Saved a passport number for ${fact.client_ref} (no scan on file)`
      return 'Updated the client record'

    case 'family_members':
      if (!result.written) return `Conflict — ${result.conflict?.message ?? 'these two are already in different families; pick one'}`
      if (fact.kind === 'relationship') {
        return `Linked ${fact.client_ref} as ${ROLE_LABEL[fact.relationship_type]} of ${fact.related_client_ref}`
      }
      return 'Linked as family member'

    case 'client_preferences':
      if (fact.kind === 'preference') return `Saved preference for ${fact.client_ref} — ${fact.category}: ${fact.preference}`
      return 'Saved preference'

    case 'knowledge_chunks':
      if (fact.kind === 'narrative') {
        const who = result.client_id ? (fact.client_ref ?? 'the client') : null
        return `Saved note${who ? ` on ${who}` : ' (not linked to a specific client)'}: "${fact.content}"`
      }
      return result.client_id ? 'Saved as a note on the client' : 'Saved as a note (not linked to a specific client)'

    case 'skipped':
      return `Skipped — ${result.reason}`
  }
}
