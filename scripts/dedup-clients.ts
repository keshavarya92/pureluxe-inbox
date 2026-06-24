/**
 * scripts/dedup-clients.ts
 *
 * One-time client deduplication script.
 * Dry-run mode by default — set DRY_RUN=false to commit writes.
 *
 * Usage:
 *   npm run dedup:clients                       # dry-run (safe, no writes)
 *   DRY_RUN=false npm run dedup:clients         # live run
 *
 * IMPORTANT — execution order:
 *   1. Run this script in dry-run mode, review output
 *   2. Run: DRY_RUN=false npm run dedup:clients  (live merge + delete)
 *   3. THEN apply supabase/migrations/003_client_dedup_constraint.sql
 *
 * Requires migrations 001 and 002 to already be applied
 * (normalized_name generated column, additional_guest_ids column).
 *
 * For each group of clients sharing a normalized_name:
 *   — picks canonical: most non-null fields; tie-break by oldest created_at
 *   — merges non-null fields from duplicates into canonical
 *   — repoints all foreign-key references to the canonical ID
 *   — deletes the duplicate rows (client_dedup_flags cascade automatically)
 */

import { createClient } from '@supabase/supabase-js'
import { config }       from 'dotenv'

config({ path: '.env.local' })

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------

const DRY_RUN = process.env.DRY_RUN !== 'false'
const LOG     = DRY_RUN ? '[DRY-RUN]        ' : '[DEDUP-CLIENTS]  '

if (!process.env.SUPABASE_URL)         throw new Error('Missing SUPABASE_URL')
if (!process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_SERVICE_KEY')

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } },
)

// buildClientMergePatch imported after dotenv so lib/supabase.ts can init.
// eslint-disable-next-line prefer-const
let buildClientMergePatch: (existing: Record<string, any>, incoming: any) => Record<string, any>

// ----------------------------------------------------------------
// Tables with scalar client_id columns to repoint
// ----------------------------------------------------------------

const SCALAR_REPOINTS: Array<{ table: string; column: string }> = [
  { table: 'air_bookings',         column: 'client_id'         },
  { table: 'airport_vip_services', column: 'client_id'         },
  { table: 'booking_pax',          column: 'client_id'         },
  { table: 'bookings',             column: 'client_id'         },
  { table: 'client_documents',     column: 'client_id'         },
  { table: 'client_health_notes',  column: 'client_id'         },
  { table: 'client_preferences',   column: 'client_id'         },
  { table: 'client_relationships', column: 'primary_client_id' },
  { table: 'client_relationships', column: 'related_client_id' },
  { table: 'email_threads',        column: 'client_id'         },
  { table: 'enquiries',            column: 'client_id'         },
  { table: 'stay_feedback',        column: 'client_id'         },
  { table: 'trips',                column: 'primary_client_id' },
  { table: 'visa_tracking',        column: 'client_id'         },
  { table: 'clients',              column: 'referred_by'       },
]

// ----------------------------------------------------------------
// Per-table repoint summary for final report
// ----------------------------------------------------------------

const repointTotals: Record<string, number> = {}

function addRepoint(table: string, column: string, n: number): void {
  const key = `${table}.${column}`
  repointTotals[key] = (repointTotals[key] ?? 0) + n
}

// ----------------------------------------------------------------
// Fetch all clients (paginated, sorted oldest-first for canonical picks)
// ----------------------------------------------------------------

async function fetchAllClients(): Promise<Record<string, any>[]> {
  const all: Record<string, any>[] = []
  let from = 0
  const PAGE = 1000

  while (true) {
    const { data, error } = await db
      .from('clients')
      .select('*')
      .range(from, from + PAGE - 1)
      .order('created_at', { ascending: true })
    if (error) throw new Error(`fetch clients (offset ${from}): ${error.message}`)
    if (!data?.length) break
    all.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  return all
}

// ----------------------------------------------------------------
// Group by normalized_name — only groups with 2+ rows
// ----------------------------------------------------------------

interface ClientGroup {
  normalizedName: string
  rows:           Record<string, any>[]
}

function groupClients(clients: Record<string, any>[]): ClientGroup[] {
  const map = new Map<string, Record<string, any>[]>()
  for (const c of clients) {
    const key = c.normalized_name as string | null
    if (!key) continue
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(c)
  }
  const groups: ClientGroup[] = []
  for (const [normalizedName, rows] of map) {
    if (rows.length > 1) groups.push({ normalizedName, rows })
  }
  return groups
}

// ----------------------------------------------------------------
// Pick canonical within a group
// ----------------------------------------------------------------

function countNonNull(row: Record<string, any>): number {
  return Object.values(row).filter(v => {
    if (v === null || v === undefined || v === '') return false
    if (typeof v === 'object' && JSON.stringify(v) === '[]') return false
    return true
  }).length
}

function pickCanonical(rows: Record<string, any>[]): Record<string, any> {
  // rows are sorted ascending by created_at from the DB query
  return rows.reduce((best, row) => {
    const diff = countNonNull(row) - countNonNull(best)
    if (diff > 0) return row
    if (diff === 0) return (row.created_at as string) < (best.created_at as string) ? row : best
    return best
  })
}

// ----------------------------------------------------------------
// Repoint a scalar FK column on one table
// ----------------------------------------------------------------

// Tables confirmed to lack service-role SELECT (noted during dry-run, skipped)
const PERMISSION_DENIED_TABLES = new Set<string>()

async function repointScalar(
  table:       string,
  column:      string,
  dupId:       string,
  canonicalId: string,
): Promise<number> {
  if (PERMISSION_DENIED_TABLES.has(table)) return 0

  // Fetch affected rows (read-only, works in both dry-run and live)
  const { data: affected, error: fetchErr } = await db
    .from(table).select('id').eq(column, dupId)
  if (fetchErr) {
    if (fetchErr.message.includes('permission denied') || fetchErr.code === '42501') {
      if (!PERMISSION_DENIED_TABLES.has(table)) {
        console.warn(`  WARN ${table}: permission denied — skipping (grant SELECT to service_role if needed)`)
        PERMISSION_DENIED_TABLES.add(table)
      }
      return 0
    }
    throw new Error(`repointScalar fetch ${table}.${column}: ${fetchErr.message}`)
  }
  const n = affected?.length ?? 0
  if (n === 0) return 0

  console.log(`  ${LOG} repoint ${table}.${column}: ${n} row(s)  ${dupId} → ${canonicalId}`)
  addRepoint(table, column, n)

  if (!DRY_RUN) {
    const { error } = await db
      .from(table)
      .update({ [column]: canonicalId })
      .eq(column, dupId)
    if (error) throw new Error(`repointScalar update ${table}.${column}: ${error.message}`)
  }
  return n
}

// ----------------------------------------------------------------
// Repoint bookings.additional_guest_ids (uuid[] array column)
// ----------------------------------------------------------------

async function repointAdditionalGuestIds(
  dupId:       string,
  canonicalId: string,
): Promise<number> {
  const { data: affected, error: fetchErr } = await db
    .from('bookings')
    .select('id, additional_guest_ids')
    .contains('additional_guest_ids', [dupId])

  if (fetchErr) {
    // Column may not exist if migration 002 hasn't been applied — skip gracefully
    if (fetchErr.message.includes('additional_guest_ids') || fetchErr.code === '42703') {
      console.warn(`  WARN bookings.additional_guest_ids column not found — skipping`)
      return 0
    }
    throw new Error(`repointAdditionalGuestIds fetch: ${fetchErr.message}`)
  }

  const n = affected?.length ?? 0
  if (n === 0) return 0

  console.log(`  ${LOG} repoint bookings.additional_guest_ids: ${n} booking(s)  ${dupId} → ${canonicalId}`)
  addRepoint('bookings', 'additional_guest_ids', n)

  if (!DRY_RUN) {
    for (const booking of affected!) {
      const newIds = [
        ...new Set(
          (booking.additional_guest_ids as string[]).map(id => id === dupId ? canonicalId : id),
        ),
      ]
      const { error } = await db
        .from('bookings')
        .update({ additional_guest_ids: newIds })
        .eq('id', booking.id)
      if (error) throw new Error(`repointAdditionalGuestIds update booking ${booking.id}: ${error.message}`)
    }
  }
  return n
}

// ----------------------------------------------------------------
// Process one duplicate group
// ----------------------------------------------------------------

interface GroupResult {
  normalizedName: string
  canonicalId:    string
  mergedFields:   string[]
  deletedIds:     string[]
}

async function processGroup(group: ClientGroup): Promise<GroupResult> {
  const canonical  = pickCanonical(group.rows)
  const duplicates = group.rows.filter(r => r.id !== canonical.id)

  console.log(`\n  normalized_name: "${group.normalizedName}"`)
  console.log(`  canonical:  ${canonical.id}  "${canonical.full_name}"`)
  for (const dup of duplicates) {
    console.log(`  duplicate:  ${dup.id}  "${dup.full_name}"`)
  }

  // Build cumulative merge patch from all duplicates into canonical
  let accumulator = { ...canonical }
  const patch: Record<string, any> = {}
  for (const dup of duplicates) {
    const p = buildClientMergePatch(accumulator, dup)
    Object.assign(patch, p)
    Object.assign(accumulator, p)
  }

  if (Object.keys(patch).length) {
    console.log(`  ${LOG} merge fields into canonical: ${Object.keys(patch).join(', ')}`)
    if (!DRY_RUN) {
      const { error } = await db.from('clients').update(patch).eq('id', canonical.id)
      if (error) throw new Error(`clients merge canonical=${canonical.id}: ${error.message}`)
    }
  } else {
    console.log(`  ${LOG} no new fields to merge`)
  }

  // Repoint all FK references for each duplicate
  for (const dup of duplicates) {
    for (const { table, column } of SCALAR_REPOINTS) {
      await repointScalar(table, column, dup.id, canonical.id)
    }
    await repointAdditionalGuestIds(dup.id, canonical.id)
  }

  // Delete duplicates (client_dedup_flags rows cascade via ON DELETE CASCADE)
  const deletedIds = duplicates.map(d => d.id as string)
  if (!DRY_RUN) {
    for (const id of deletedIds) {
      const { error } = await db.from('clients').delete().eq('id', id)
      if (error) throw new Error(`clients delete id=${id}: ${error.message}`)
      console.log(`  ${LOG} deleted client ${id}`)
    }
  } else {
    for (const id of deletedIds) {
      console.log(`  ${LOG} would delete client ${id}`)
    }
  }

  return {
    normalizedName: group.normalizedName,
    canonicalId:    canonical.id,
    mergedFields:   Object.keys(patch),
    deletedIds,
  }
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(62))
  console.log(`  Client deduplication — ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE RUN'}`)
  console.log('═'.repeat(62) + '\n')

  // Dynamic import after dotenv so lib/supabase.ts can read SUPABASE_URL
  const resolvers = await import('../lib/resolvers')
  buildClientMergePatch = resolvers.buildClientMergePatch

  const clients = await fetchAllClients()
  console.log(`Fetched ${clients.length} client(s)`)

  const groups = groupClients(clients)
  const totalDups = groups.reduce((n, g) => n + g.rows.length - 1, 0)
  console.log(`Found ${groups.length} duplicate group(s) — ${totalDups} client(s) to remove\n`)

  if (groups.length === 0) {
    console.log('Nothing to do.\n')
    return
  }

  console.log('─'.repeat(62))
  console.log('GROUPS')
  console.log('─'.repeat(62))

  const results: GroupResult[] = []
  for (const group of groups) {
    results.push(await processGroup(group))
  }

  // ── Summary ───────────────────────────────────────────────────
  const totalDeleted = results.reduce((n, r) => n + r.deletedIds.length, 0)
  console.log('\n' + '─'.repeat(62))
  console.log('SUMMARY')
  console.log('─'.repeat(62))
  console.log(`  Groups processed:              ${results.length}`)
  console.log(`  Duplicates ${DRY_RUN ? 'to delete' : 'deleted'}:           ${totalDeleted}`)

  if (Object.keys(repointTotals).length) {
    console.log(`  Rows repointed:`)
    for (const [key, count] of Object.entries(repointTotals).sort()) {
      console.log(`    ${count.toString().padStart(4)}  ${key}`)
    }
  } else {
    console.log(`  Rows repointed:                0`)
  }

  if (DRY_RUN) {
    console.log('\n  ⚠  DRY RUN — no changes were written.')
    console.log('     Re-run with DRY_RUN=false to apply.')
    console.log('     After live run, apply migration 003_client_dedup_constraint.sql\n')
  } else {
    console.log('\n  ✓  Live run complete.')
    console.log('     Next: apply supabase/migrations/003_client_dedup_constraint.sql\n')
  }
}

main().catch(err => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
