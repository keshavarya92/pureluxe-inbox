/**
 * scripts/import-legacy-bookings.ts
 *
 * One-time import of legacy booking records from a CSV export.
 * Dry-run mode by default — set DRY_RUN=false to commit writes.
 *
 * BEFORE RUNNING:
 *   1. Place the CSV at data/legacy-bookings.csv
 *   2. Apply supabase/migrations/001_resolvers.sql (adds normalized_name
 *      generated column + pg_trgm index required by resolveClient)
 *   3. npm install  (installs csv-parse, dotenv, tsx if not already present)
 *
 * Usage:
 *   npm run import:legacy                    # dry-run (safe, no writes)
 *   DRY_RUN=false npm run import:legacy      # live run
 *
 * NOTE: resolveClient is imported via dynamic import (inside main) so that
 * dotenv can populate env vars before lib/supabase.ts is loaded — that module
 * throws at load time if SUPABASE_URL / SUPABASE_SERVICE_KEY are missing.
 *
 * buildBookingPatch is reimplemented inline because it is not exported from
 * lib/resolvers.ts. Logic is kept identical to the source.
 */

import path from 'path'
import fs   from 'fs'
import { parse }        from 'csv-parse/sync'
import { createClient } from '@supabase/supabase-js'
import { config }       from 'dotenv'

config({ path: '.env.local' })

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

const DRY_RUN  = process.env.DRY_RUN !== 'false'
const LOG      = DRY_RUN ? '[DRY-RUN]' : '[IMPORT] '
const CSV_PATH = path.join(process.cwd(), 'data', 'legacy-bookings.csv')
const TODAY    = new Date().toISOString().slice(0, 10)

const TEAM_EMAIL_MAP: Record<string, string> = {
  SONALI:  'sonali@kft.travel',
  KESHAV:  'keshav@kft.travel',
  SANJAY:  'sanjay@kft.travel',
  SHILPA:  'shilpa@kft.travel',
  SHREYA:  'operations@kft.travel',
  PRIYA:   'operations@kft.travel',
  SUCHITA: 'holidays@kft.travel',
  RIA:     'tours@kft.travel',
}

// Pre-processing corrections applied before resolveClient and property lookup.
// Keys are UPPERCASED raw values from the CSV.
const NAME_CORRECTIONS: Record<string, string> = {
  'ROAHN JAIN':                      'ROHAN JAIN',
  'MANDARAIN ORIENTAL THE LANDMARK': 'MANDARIN ORIENTAL THE LANDMARK',
}

// ----------------------------------------------------------------
// buildBookingPatch — mirrors the private function in lib/resolvers.ts.
// Cannot import: function is not exported. Logic kept identical.
// ----------------------------------------------------------------

const BOOKING_FILLABLE = [
  'hotel_ref', 'amadeus_ref', 'lhw_ref', 'ottila_ref', 'onyx_ref',
  'total_cost', 'currency', 'total_cost_usd',
  'commission_rate', 'commission_expected', 'commission_channel', 'commissionable',
  'cancellation_deadline', 'cancellation_policy',
  'num_rooms', 'num_adults', 'num_children',
  'special_occasion', 'vip_flag', 'group_name', 'status',
  'booking_source', 'booking_channel', 'misc',
] as const

function buildBookingPatch(
  canonical: Record<string, any>,
  incoming:  Record<string, any>,
): Record<string, any> {
  const patch: Record<string, any> = {}
  for (const f of BOOKING_FILLABLE) {
    if ((canonical[f] === null || canonical[f] === undefined) && incoming[f] != null) {
      patch[f] = incoming[f]
    }
  }
  if (incoming.notes) {
    const existing = (canonical.notes as string | null) ?? ''
    if (!existing.includes(incoming.notes)) {
      patch.notes = existing ? `${existing}\n${incoming.notes}` : incoming.notes
    }
  }
  return patch
}

// ----------------------------------------------------------------
// Supabase client (created after dotenv runs)
// ----------------------------------------------------------------

if (!process.env.SUPABASE_URL)         throw new Error('Missing SUPABASE_URL')
if (!process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing SUPABASE_SERVICE_KEY')

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } },
)

// ----------------------------------------------------------------
// Parsers
// ----------------------------------------------------------------

const MONTH_MAP: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

/** Parse "1 Jan", "2-Jan", "2Jan", "10Jul" etc. → "2026-MM-DD". All year 2026. */
function parseCheckDate(raw: string): string | null {
  const s = raw?.trim()
  if (!s) return null
  const m = /^(\d{1,2})[\s\-]?([A-Za-z]{3})/i.exec(s)
  if (!m) return null
  const month = MONTH_MAP[m[2].toLowerCase()]
  if (!month) return null
  return `2026-${month}-${m[1].padStart(2, '0')}`
}

/** Parse "23/01/2026" → "2026-01-23". */
function parseReceivedDate(raw: string): string | null {
  const s = raw?.trim()
  if (!s) return null
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (!m) return null
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

/** Remove commas, parse to float; null if blank or NaN. */
function parseNumeric(raw: string | undefined): number | null {
  const s = raw?.replace(/,/g, '').trim()
  if (!s) return null
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

/** Strip "(N ROOMS)" / "( N ROOMS )" suffix (case-insensitive). */
function stripRoomCount(name: string): { cleanName: string; numRooms: number | null } {
  const m = /\s*\(\s*(\d+)\s+ROOMS?\s*\)\s*$/i.exec(name)
  if (!m) return { cleanName: name.trim(), numRooms: null }
  return { cleanName: name.slice(0, m.index).trim(), numRooms: parseInt(m[1], 10) }
}

// ----------------------------------------------------------------
// Caches
// ----------------------------------------------------------------

const teamMemberCache   = new Map<string, string | null>()  // email → uuid
const propertyIdCache   = new Map<string, string>()         // normalised name → uuid

// ----------------------------------------------------------------
// Team member resolver
// ----------------------------------------------------------------

async function resolveTeamMember(firstName: string): Promise<string | null> {
  const key   = firstName.trim().toUpperCase()
  const email = TEAM_EMAIL_MAP[key]
  if (!email) return null

  if (teamMemberCache.has(email)) return teamMemberCache.get(email)!

  const { data } = await db.from('team_members').select('id').eq('email', email).maybeSingle()
  const id = data?.id ?? null
  teamMemberCache.set(email, id)
  if (!id) console.warn(`  WARN team_member not found for email ${email} (${firstName})`)
  return id
}

// ----------------------------------------------------------------
// City conflict detection
// ----------------------------------------------------------------

// Maps country names (as they appear in the CSV "City" column) to patterns
// that identify specific cities/regions within that country. A fuzzy property
// match is accepted (cosmetic) when the CSV city is a country name and the
// DB city matches a known region within it — e.g. "MALDIVES" vs "Lhaviyani Atoll".
const COUNTRY_CITY_PATTERNS: Record<string, RegExp> = {
  'MALDIVES':   /atoll|island|male|hulhumale/i,
  'INDONESIA':  /bali|lombok|java|sumatra|ubud|seminyak|nusa|uluwatu/i,
  'THAILAND':   /phuket|koh|bangkok|chiang|samui|krabi|hua hin/i,
  'FRANCE':     /paris|riviera|provence|nice|cannes|lyon|monaco|bordeaux/i,
  'ITALY':      /rome|milan|florence|venice|sicily|amalfi|capri|sorrento/i,
  'SPAIN':      /madrid|barcelona|seville|ibiza|mallorca|marbella|costa/i,
  'GREECE':     /athens|mykonos|santorini|rhodes|crete|corfu/i,
  'MAURITIUS':  /port louis|grand baie|belle mare|flic|trou/i,
  'SEYCHELLES': /mahe|praslin|la digue|victoria/i,
  'UAE':        /dubai|abu dhabi|sharjah/i,
  'INDIA':      /mumbai|delhi|goa|jaipur|udaipur|kerala|agra/i,
  'SRI LANKA':  /colombo|kandy|galle|negombo|sigiriya/i,
  'KENYA':      /nairobi|mombasa|masai mara|amboseli|laikipia/i,
  'TANZANIA':   /dar es salaam|serengeti|zanzibar|kilimanjaro|arusha/i,
}

// Returns true when the CSV city and DB city represent genuinely different locations.
// Returns false when the conflict is cosmetic (CSV city is a country, DB city is within it).
function isGenuineCityConflict(csvCity: string, dbCity: string): boolean {
  const csvU = csvCity.trim().toUpperCase()
  const dbU  = dbCity.trim().toUpperCase()

  if (csvU === dbU) return false  // same city — no conflict

  const pattern = COUNTRY_CITY_PATTERNS[csvU]
  if (pattern && pattern.test(dbCity.trim())) return false  // cosmetic: DB city is within CSV country

  return true  // genuine mismatch
}

// ----------------------------------------------------------------
// Property resolver / creator
// ----------------------------------------------------------------

async function resolveOrCreateProperty(
  hotelName: string,
  city:      string | null,
  chain:     string | null,
): Promise<{ id: string; isNew: boolean; fuzzyName: string | null }> {
  const normKey = hotelName.toLowerCase().trim()
  if (propertyIdCache.has(normKey)) {
    return { id: propertyIdCache.get(normKey)!, isNew: false, fuzzyName: null }
  }

  // Try ILIKE contains match
  const { data: matches, error: matchErr } = await db
    .from('properties')
    .select('id, name, city')
    .ilike('name', `%${hotelName.trim()}%`)
    .limit(1)
  if (matchErr) throw new Error(`property lookup: ${matchErr.message}`)

  if (matches?.length) {
    const found    = matches[0]
    const wasFuzzy = found.name.trim().toLowerCase() !== hotelName.trim().toLowerCase()

    if (wasFuzzy && city && found.city && isGenuineCityConflict(city, found.city)) {
      // Genuine city conflict on a fuzzy match — reject and create a new property.
      console.warn(`  WARN fuzzy match rejected (city conflict): "${hotelName}" → "${found.name}" CSV="${city}" DB="${found.city}" — will create new property`)
      // fall through to insert path below
    } else {
      if (city && found.city && found.city.toLowerCase() !== city.toLowerCase()) {
        console.warn(`  WARN city conflict (cosmetic, accepting): hotel "${hotelName}" — CSV="${city}" DB="${found.city}"`)
      }
      propertyIdCache.set(normKey, found.id)
      return { id: found.id, isNew: false, fuzzyName: wasFuzzy ? found.name : null }
    }
  }

  // Not found — insert new
  if (DRY_RUN) {
    const fakeId = `dry-run-prop-${normKey}`
    propertyIdCache.set(normKey, fakeId)
    console.log(`${LOG} property would create: "${hotelName}" city="${city ?? ''}" chain="${chain ?? ''}"`)
    return { id: fakeId, isNew: true, fuzzyName: null }
  }

  const { data: created, error: createErr } = await db
    .from('properties')
    .insert({ name: hotelName.trim(), city: city ?? null, chain: chain ?? null, active: true })
    .select('id')
    .single()
  if (createErr) throw new Error(`property insert "${hotelName}": ${createErr.message}`)
  console.log(`${LOG} property created id=${created.id} "${hotelName}"`)
  propertyIdCache.set(normKey, created.id)
  return { id: created.id, isNew: true, fuzzyName: null }
}

// ----------------------------------------------------------------
// Stats
// ----------------------------------------------------------------

const stats = {
  rowsProcessed:       0,
  rowsSkipped:         0,
  rowsSkippedDateError: 0,
  clientsResolved:     0,
  propertiesCreated:   0,
  bookingsInserted:    0,
  bookingsMerged:      0,
  commissionsCreated:  0,
  paymentsCreated:     0,
}
const skipReasons: Record<string, number> = {}

function recordSkip(reason: string): void {
  skipReasons[reason] = (skipReasons[reason] ?? 0) + 1
  stats.rowsSkipped++
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(64))
  console.log(`  Legacy booking import — ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE RUN'}`)
  console.log('═'.repeat(64) + '\n')

  // Dynamic import so dotenv runs before lib/supabase.ts is loaded
  const { resolveClient } = await import('../lib/resolvers')

  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`CSV not found at ${CSV_PATH} — see script header for setup instructions`)
  }

  const raw     = fs.readFileSync(CSV_PATH, 'utf-8')
  const records = parse(raw, {
    columns:           true,
    skip_empty_lines:  true,
    trim:              true,
    bom:               true,       // handle Excel UTF-8 BOM
    relax_column_count: true,      // allow trailing comma in header
  }) as Record<string, string>[]

  console.log(`Parsed ${records.length} record(s) from CSV\n`)

  for (let i = 0; i < records.length; i++) {
    const row    = records[i]
    const rowNum = i + 2  // 1-indexed, +1 for header

    // Skip rows where every field is blank
    const allBlank = Object.values(row).every(v => !v?.trim())
    if (allBlank) {
      console.log(`  row ${rowNum}: skip (empty)`)
      recordSkip('empty row')
      continue
    }

    try {
      // ── 1. Parse & clean ────────────────────────────────────────
      const rawName        = row['Client Name'] ?? ''
      const correctedName  = NAME_CORRECTIONS[rawName.trim().toUpperCase()] ?? rawName
      const { cleanName, numRooms: nameRooms } = stripRoomCount(correctedName)

      if (!cleanName) {
        console.warn(`  row ${rowNum}: skip — blank client name after stripping`)
        recordSkip('blank client name')
        continue
      }

      const norRooms  = parseNumeric(row['NOR'])
      const num_rooms = norRooms ? Math.round(norRooms) : (nameRooms ?? 1)

      const rawHotelName     = row['Hotel Booked']?.trim() ?? ''
      const hotelName        = NAME_CORRECTIONS[rawHotelName.toUpperCase()] ?? rawHotelName
      const city             = row['City']?.trim()             || null
      const bookedByFirst    = row['Booked By']?.trim()        || null
      const chain            = row['Chain']?.trim()            || null
      const bookingChannel   = row['Booking Channel']?.trim()  || null
      const commissionChannel = row['Channel']?.trim()         || null

      if (!hotelName) {
        console.warn(`  row ${rowNum}: skip — blank hotel name (client "${cleanName}")`)
        recordSkip('blank hotel name')
        continue
      }

      const checkIn  = parseCheckDate(row['Check-in']  ?? '')
      const checkOut = parseCheckDate(row['Check Out'] ?? '')

      if (!checkIn || !checkOut) {
        console.warn(`  row ${rowNum}: skip — unparseable date(s) check-in="${row['Check-in']}" check-out="${row['Check Out']}" (client "${cleanName}")`)
        recordSkip('unparseable dates')
        continue
      }

      if (checkOut <= checkIn) {
        console.warn(`  row ${rowNum}: skip — inverted dates check-in="${checkIn}" check-out="${checkOut}" (client "${cleanName}")`)
        stats.rowsSkippedDateError++
        continue
      }

      const totalCost          = parseNumeric(row['Total Cost before taxes'])
      const commissionExpected = parseNumeric(row['Expected Commission'])
      const currency           = row['FCY']?.trim()   || null
      const totalCostUsd       = parseNumeric(row['USD'])

      const dateReceivedRaw = row['Date Received']?.trim() || null
      const paymentAmtRaw   = row['Amount']?.trim()        || null
      const dateReceived    = dateReceivedRaw ? parseReceivedDate(dateReceivedRaw) : null
      const paymentAmount   = paymentAmtRaw   ? parseNumeric(paymentAmtRaw)        : null

      if (dateReceivedRaw && !dateReceived) {
        console.warn(`  row ${rowNum}: WARN unparseable Date Received "${dateReceivedRaw}" — skipping payment record`)
      }

      const status = checkOut < TODAY ? 'checked_out' : 'confirmed'

      // ── 2. Resolve client ────────────────────────────────────────
      let clientId: string
      try {
        clientId = await resolveClient({ full_name: cleanName })
        console.log(`${LOG} row ${rowNum}: client resolved id=${clientId} "${cleanName}"`)
        stats.clientsResolved++
      } catch (err: any) {
        const msg = err?.message ?? String(err)
        console.error(`  row ${rowNum}: skip — resolveClient failed for "${cleanName}": ${msg}`)
        recordSkip(`resolveClient: ${msg}`)
        continue
      }

      // ── 3. Resolve property ──────────────────────────────────────
      const { id: propertyId, isNew: propIsNew, fuzzyName } =
        await resolveOrCreateProperty(hotelName, city, chain)

      if (propIsNew) {
        stats.propertiesCreated++
      } else if (fuzzyName) {
        console.warn(`  row ${rowNum}: WARN fuzzy property match "${hotelName}" → "${fuzzyName}"`)
      }

      // ── 4. Resolve team member ───────────────────────────────────
      const bookedBy = bookedByFirst ? await resolveTeamMember(bookedByFirst) : null
      if (bookedByFirst && !bookedBy) {
        console.warn(`  row ${rowNum}: WARN team member "${bookedByFirst}" not in mapping/DB`)
      }

      // ── 5 & 6. Dedup and insert/merge booking ───────────────────
      const bookingFields = {
        client_id:            clientId,
        client_name:          cleanName,
        property_id:          propertyId,
        num_rooms:            num_rooms,
        total_cost:           totalCost,
        currency:             currency,
        total_cost_usd:       totalCostUsd,
        commission_expected:  commissionExpected,
        commission_channel:   commissionChannel,
        chain:                chain,
        booking_channel:      bookingChannel,
        check_in:             checkIn,
        check_out:            checkOut,
        booked_by:            bookedBy,
        booking_source:       'legacy_import',
        commissionable:       true,
        status,
      }

      const { data: existing } = await db
        .from('bookings')
        .select('*')
        .eq('client_id',   clientId)
        .eq('property_id', propertyId)
        .eq('check_in',    checkIn)
        .eq('check_out',   checkOut)
        .limit(1)

      let bookingId: string

      if (existing?.length) {
        const canonical = existing[0]
        bookingId       = canonical.id
        const patch     = buildBookingPatch(canonical, bookingFields)

        if (Object.keys(patch).length) {
          console.log(`${LOG} row ${rowNum}: booking merged id=${bookingId} fields=${Object.keys(patch).join(',')}`)
          if (!DRY_RUN) {
            const { error } = await db.from('bookings')
              .update({ ...patch, updated_at: new Date().toISOString() })
              .eq('id', bookingId)
            if (error) throw new Error(`booking merge: ${error.message}`)
          }
        } else {
          console.log(`${LOG} row ${rowNum}: booking already up-to-date id=${bookingId}`)
        }
        stats.bookingsMerged++
      } else {
        if (DRY_RUN) {
          bookingId = `dry-run-booking-${rowNum}`
          console.log(`${LOG} row ${rowNum}: booking would insert "${cleanName}" @ "${hotelName}" ${checkIn}→${checkOut}`)
        } else {
          const { data: inserted, error } = await db
            .from('bookings')
            .insert(bookingFields)
            .select('id')
            .single()
          if (error) throw new Error(`booking insert: ${error.message}`)
          bookingId = inserted.id
          console.log(`${LOG} row ${rowNum}: booking inserted id=${bookingId} "${cleanName}" @ "${hotelName}"`)
        }
        stats.bookingsInserted++
      }

      // ── 7. Commission record ─────────────────────────────────────
      if (commissionExpected && commissionExpected > 0) {
        const commCurrency = currency ?? 'USD'
        const hasPayment   = !!(dateReceived && paymentAmount)

        // Diagnostic: log which field is blocking payment creation
        if (!hasPayment) {
          const whyNo = [
            !dateReceived  ? `Date Received="${dateReceivedRaw ?? '(blank)'}"` : null,
            !paymentAmount ? `Amount="${paymentAmtRaw ?? '(blank)'}"` : null,
          ].filter(Boolean).join(', ')
          console.log(`  row ${rowNum}: no payment record — ${whyNo}`)
        }

        let commissionId: string | null = null

        if (DRY_RUN) {
          commissionId = `dry-run-commission-${rowNum}`
          console.log(`${LOG} row ${rowNum}: commission would create amount=${commissionExpected} ${commCurrency} status=${hasPayment ? 'received' : 'pending'}`)
          stats.commissionsCreated++
        } else {
          // Idempotent: use existing commission if one already exists for this booking
          const { data: existingComm } = await db
            .from('commissions')
            .select('id')
            .eq('booking_id', bookingId)
            .maybeSingle()

          if (existingComm) {
            commissionId = existingComm.id
            console.log(`${LOG} row ${rowNum}: commission exists id=${commissionId} — skip insert`)
          } else {
            const { data: comm, error: commErr } = await db
              .from('commissions')
              .insert({
                booking_id:      bookingId,
                amount_expected: commissionExpected,
                currency:        commCurrency,
                channel:         commissionChannel,
                status:          hasPayment ? 'received' : 'pending',
                ...(hasPayment ? {
                  amount_received: paymentAmount,
                  date_received:   dateReceived,
                } : {}),
              })
              .select('id')
              .single()
            if (commErr) throw new Error(`commission insert: ${commErr.message}`)
            commissionId = comm.id
            console.log(`${LOG} row ${rowNum}: commission created id=${commissionId} status=${hasPayment ? 'received' : 'pending'}`)
            stats.commissionsCreated++
          }
        }

        // ── Commission payment record ────────────────────────────
        if (hasPayment && commissionId) {
          if (DRY_RUN) {
            console.log(`${LOG} row ${rowNum}: payment would create amount=${paymentAmount} ${commCurrency} date=${dateReceived} method=${commissionChannel ?? ''}`)
            stats.paymentsCreated++
          } else {
            // Idempotent: check for existing payment before inserting
            const { data: existingPay } = await db
              .from('commission_payments')
              .select('id')
              .eq('commission_id', commissionId)
              .maybeSingle()

            if (existingPay) {
              console.log(`${LOG} row ${rowNum}: payment exists id=${existingPay.id} — skip insert`)
            } else {
              const { error: payErr } = await db.from('commission_payments').insert({
                commission_id:  commissionId,
                amount:         paymentAmount!,
                currency:       commCurrency,
                payment_date:   dateReceived!,
                payment_method: commissionChannel ?? null,
              })
              if (payErr) {
                // Non-fatal: log and continue — don't let a payment error kill the whole row
                console.error(`  row ${rowNum}: payment insert FAILED commission_id=${commissionId}: ${payErr.message}`)
              } else {
                console.log(`${LOG} row ${rowNum}: payment created commission_id=${commissionId}`)
                stats.paymentsCreated++
              }
            }
          }
        }
      }

      stats.rowsProcessed++

    } catch (err: any) {
      const msg = err?.message ?? String(err)
      console.error(`  row ${rowNum}: ERROR — ${msg}`)
      recordSkip(`error: ${msg}`)
    }
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(64))
  console.log('SUMMARY')
  console.log('─'.repeat(64))
  console.log(`  Rows processed:          ${stats.rowsProcessed}`)
  console.log(`  Rows skipped:            ${stats.rowsSkipped}`)
  console.log(`  Rows skipped (date err): ${stats.rowsSkippedDateError}`)
  if (Object.keys(skipReasons).length) {
    console.log('  Skip reason breakdown:')
    for (const [reason, count] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${count.toString().padStart(4)}  ${reason}`)
    }
  }
  console.log(`  Clients resolved:        ${stats.clientsResolved}`)
  console.log(`  Properties created:      ${stats.propertiesCreated}`)
  console.log(`  Bookings inserted:       ${stats.bookingsInserted}`)
  console.log(`  Bookings merged:         ${stats.bookingsMerged}`)
  console.log(`  Commissions created:     ${stats.commissionsCreated}`)
  console.log(`  Payments created:        ${stats.paymentsCreated}`)
  if (DRY_RUN) {
    console.log('\n  ⚠  DRY RUN — no changes were written.')
    console.log('     Re-run with DRY_RUN=false to apply.\n')
  } else {
    console.log('\n  ✓  Live run complete.\n')
  }
}

main().catch(err => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
