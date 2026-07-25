// Gap detection + family-structure question queue — AGENTS.md Section 6.1/6.2.
// Session 1 scope: family-structure gaps only (who's in this family, are they
// linked correctly, duplicates, primary contact). Contact/passport/preference
// gap categories from 6.1 are deferred to a later session.
//
// Stateless by design: there's no interview_sessions table in Session 1, so
// the full queue is computed once here and handed to the chat UI, which
// echoes back the remaining questions on each /interview/answer call. See
// app/api/trainer/interview/answer/route.ts.

import { supabase } from '../supabase'

const CLEANUP_REVIEWERS = ['dedup_script', 'cleanup_script', 'compound_name_cleanup']

export interface QueueQuestion {
  id: string
  // null for family-level questions (the catch-all) that aren't about one client
  client_id: string | null
  client_name: string
  category: 'family_structure'
  reason: 'no_family_link' | 'needs_reverification' | 'unlinked_implied_member' | 'catch_all' | 'family_link_check'
  prompt: string
}

export interface FamilyCluster {
  family_id: string
  family_name: string
  client_ids: string[]
}

export interface InterviewQueue {
  query: string
  matched_client_ids: string[]
  // Full names of everyone already on file for this surname — pass to
  // extractFacts() as `knownNames` so a shortened/partial mention (e.g.
  // "Atul" instead of "Atul Champaklal Choksey") resolves to the exact
  // existing name instead of resolveClient() creating a duplicate. Found
  // live on the Choksey pass: a catch-all answer using shortened names
  // spawned two stray client records before this was added.
  matched_client_names: string[]
  matched_family_ids: string[]
  questions: QueueQuestion[]
}

export interface DisambiguationNeeded {
  disambiguation: true
  query: string
  clusters: FamilyCluster[]
}

export type InterviewStartResult = InterviewQueue | DisambiguationNeeded

// Trailing-s tolerant surname matching ("Agarwals" vs "Agarwal").
function surnameVariants(input: string): string[] {
  const base = input.trim().toLowerCase()
  const variants = new Set([base])
  if (base.endsWith('s') && base.length > 2) variants.add(base.slice(0, -1))
  else variants.add(`${base}s`)
  return [...variants]
}

export async function buildInterviewQueue(query: string): Promise<InterviewStartResult> {
  const variants = surnameVariants(query)
  const orFilter = variants.map(v => `normalized_name.ilike.%${v}%`).join(',')

  const { data: looseMatches, error: cErr } = await supabase
    .from('clients')
    .select('id, full_name, normalized_name, reviewed_by, general_notes, internal_notes, misc')
    .or(orFilter)
  if (cErr) throw new Error(`buildInterviewQueue clients: ${cErr.message}`)

  // The ilike above is a substring match, so "Jain" also catches "Jainee
  // Doshi" (surname Doshi, not Jain) — found live on the Jain pass, 2 of 27
  // initial matches were unrelated people whose name merely contains the
  // surname as a substring. Require the surname to match a WHOLE WORD in
  // normalized_name (handles both "Jain Sandeep" and "Sandeep Jain"
  // orderings, but not "Jainee").
  const clients = (looseMatches ?? []).filter(c => {
    const words = (c.normalized_name ?? '').split(/\s+/)
    return variants.some(v => words.includes(v))
  })

  if (!clients.length) {
    return { query, matched_client_ids: [], matched_client_names: [], matched_family_ids: [], questions: [] }
  }

  const clientIds = clients.map(c => c.id)

  const { data: memberships, error: mErr } = await supabase
    .from('family_members')
    .select('family_id, client_id')
    .in('client_id', clientIds)
  if (mErr) throw new Error(`buildInterviewQueue family_members: ${mErr.message}`)

  const linkedClientIds = new Set((memberships ?? []).map(m => m.client_id))
  const distinctFamilyIds = [...new Set((memberships ?? []).map(m => m.family_id))]

  // More than one distinct family already exists across this surname's
  // clients — surface both and let the team member pick, rather than
  // presenting one merged queue that may conflate two unrelated households.
  if (distinctFamilyIds.length > 1) {
    const { data: families, error: fErr } = await supabase
      .from('families')
      .select('id, family_name')
      .in('id', distinctFamilyIds)
    if (fErr) throw new Error(`buildInterviewQueue families: ${fErr.message}`)

    const clusters: FamilyCluster[] = (families ?? []).map(f => ({
      family_id: f.id,
      family_name: f.family_name,
      client_ids: (memberships ?? []).filter(m => m.family_id === f.id).map(m => m.client_id),
    }))
    return { disambiguation: true, query, clusters }
  }

  const questions: QueueQuestion[] = []

  for (const c of clients) {
    if (!linkedClientIds.has(c.id)) {
      questions.push({
        id: `${c.id}:no_family_link`,
        client_id: c.id,
        client_name: c.full_name,
        category: 'family_structure',
        reason: 'no_family_link',
        prompt: `Is ${c.full_name} linked to a family? Who are they related to (spouse, parent, child, sibling)?`,
      })
    } else if (CLEANUP_REVIEWERS.includes(c.reviewed_by ?? '')) {
      questions.push({
        id: `${c.id}:needs_reverification`,
        client_id: c.id,
        client_name: c.full_name,
        category: 'family_structure',
        reason: 'needs_reverification',
        prompt: `${c.full_name}'s record was touched by an earlier cleanup pass (${c.reviewed_by}). Can you confirm their name and family link are still correct?`,
      })
    }

    // Implied-companion check — does this client's own notes mention the
    // first name of another same-surname client who isn't linked yet?
    const noteText = [c.general_notes, c.internal_notes, c.misc].filter(Boolean).join(' ').toLowerCase()
    if (!noteText) continue
    for (const other of clients) {
      if (other.id === c.id || linkedClientIds.has(other.id)) continue
      const firstName = other.full_name.split(/\s+/)[0]?.toLowerCase()
      // Skip when the "first word" is actually the surname itself (surname-
      // first records like "Jain Sandeep" — found live on the Jain pass,
      // where this generated dozens of meaningless questions since nearly
      // every same-surname client's notes mention the surname somewhere).
      if (firstName && variants.includes(firstName)) continue
      if (firstName && firstName.length > 2 && noteText.includes(firstName)) {
        questions.push({
          id: `${c.id}:implied:${other.id}`,
          client_id: c.id,
          client_name: c.full_name,
          category: 'family_structure',
          reason: 'unlinked_implied_member',
          prompt: `${c.full_name}'s notes mention "${other.full_name.split(/\s+/)[0]}" — is that ${other.full_name}? If so, how are they related?`,
        })
      }
    }
  }

  // Catch-all — always last, always asked, family-level (no single client_id).
  questions.push({
    id: `catch_all`,
    client_id: null,
    client_name: query,
    category: 'family_structure',
    reason: 'catch_all',
    prompt: `Anything else about the ${query} family worth knowing?`,
  })

  return {
    query,
    matched_client_ids: clientIds,
    matched_client_names: clients.map(c => c.full_name),
    matched_family_ids: distinctFamilyIds,
    questions,
  }
}

export interface FamilySplitFamily {
  family_id: string
  family_name: string
  client_count: number
}

// Called once, right as an interview pass is about to end (see
// app/api/trainer/interview/answer/route.ts). The queue is precomputed at
// /interview/start time, before any answers exist, so it can't know that
// mid-session answers will scatter this surname's clients across multiple
// new family records — found live on the Choksey pass: two real households
// (Parul+Atul, Abhiraj+Biyash+Alekha) ended up as two disconnected family
// rows with nothing ever asking whether they're the same extended family.
export async function checkFamilySplit(clientIds: string[]): Promise<FamilySplitFamily[] | null> {
  if (!clientIds.length) return null
  const { data: memberships, error } = await supabase
    .from('family_members')
    .select('family_id, client_id')
    .in('client_id', clientIds)
  if (error) throw new Error(`checkFamilySplit family_members: ${error.message}`)

  const distinctFamilyIds = [...new Set((memberships ?? []).map(m => m.family_id))]
  if (distinctFamilyIds.length < 2) return null

  const { data: families, error: fErr } = await supabase
    .from('families')
    .select('id, family_name')
    .in('id', distinctFamilyIds)
  if (fErr) throw new Error(`checkFamilySplit families: ${fErr.message}`)

  return (families ?? []).map(f => ({
    family_id: f.id,
    family_name: f.family_name,
    client_count: (memberships ?? []).filter(m => m.family_id === f.id).length,
  }))
}
