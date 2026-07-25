// Trainer Chat Session 1 gate: before the Agarwal family-priority interview
// queue is built, check whether the "inferred from hotel reference to
// 'Mr. Agarwal'" boilerplate note (pasted across ~40 unrelated client
// records, see AGENTS.md Section 6.3) is still present. Review the count
// and decide whether to strip it before Agarwal questions are exposed.
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false } })

const BOILERPLATE_SNIPPET = `inferred from hotel reference to 'Mr. Agarwal'`

async function main() {
  const { data, error } = await db
    .from('clients')
    .select('id, full_name, normalized_name, general_notes, internal_notes')
    .or(`general_notes.ilike.%${BOILERPLATE_SNIPPET}%,internal_notes.ilike.%${BOILERPLATE_SNIPPET}%`)

  if (error) {
    console.error('[audit-agarwal-boilerplate] query failed:', error.message)
    process.exit(1)
  }

  const rows = data ?? []
  console.log(`--- Clients with Agarwal boilerplate note: ${rows.length} ---`)
  for (const r of rows) {
    const field = (r.general_notes ?? '').includes(BOILERPLATE_SNIPPET) ? 'general_notes' : 'internal_notes'
    console.log(` ${r.id}  ${r.full_name ?? '(null)'}  norm="${r.normalized_name ?? ''}"  field=${field}`)
  }

  if (rows.length) {
    console.log(
      `\n${rows.length} record(s) carry the boilerplate note. Do NOT start the Agarwal ` +
      `interview queue until this is reviewed — strip the note (or otherwise confirm ` +
      `these records have no real connection to each other) first.`,
    )
  } else {
    console.log('\nNo boilerplate note found — Agarwal queue is clear to build.')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
