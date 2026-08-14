# Task Time Estimates — Experienced Engineer

Estimates assume familiarity with this codebase's existing patterns (Next.js app router,
Supabase, Anthropic tool-calling agent shape already established in `lib/trainer/` and
`lib/trip-builder/`). Status column reflects `BUILD_TRACKER.md`'s code-verified findings,
not the Sheet's original claims. "Done" = 0h. Ranges reflect real uncertainty, not padding —
take the midpoint for planning, the top end for commitments.

## Trip Builder

| Task | Status | Est. hours |
|---|---|---|
| Migration (schema) | Done | 0 |
| Trip queries (`resolveTrip` equivalent) | Done | 0 |
| Rate draft extraction endpoint | Done | 0 |
| KB suggestion tool | Done | 0 |
| Chat backend | Done | 0 |
| Chat UI | Done | 0 |
| Sidebar UI | Done, uncommitted | 0.5 (commit + verify) |
| Document generator service | Looks done, unverified end-to-end | 2 (verification pass, not a build) |

**Subtotal: ~2.5h**

## Atlas KB

| Task | Status | Est. hours |
|---|---|---|
| Hotels/Restaurants/Experiences/Destinations tables + trust tiers + `direct_routes` + `scrape_sources` + `advisor_notes` | **Unknown — needs reconciliation first** | TBD (0h if descoped/already live in Supabase; ~8–10h combined schema+migration work if genuinely still needed) |
| Fuzzy resolver + `resolver_log` | Designed, not built | 4–6 |
| Full SQL migration run confirmation | Needs verification | 0.5 |
| Scraper: Playwright fetch | Not started | 3–4 |
| Scraper: Cheerio parse | Not started, depends on fetch | 2–3 |
| Scraper: LLM extractor | Not started, depends on parse | 3–4 |
| Scraper: Zod validation | Not started, depends on extractor | 1.5–2 |
| Scraper: Supabase write | Not started, depends on validation | 1.5–2 |
| Drive itinerary ingestion (52 docs) | Not started, depends on full scraper | 6–8 |
| Version-sprawl resolution logic | Decided, not implemented | 2.5–3 |
| pgvector `knowledge_chunks` | Designed, not built | 5–6 |

**Subtotal (excluding TBD schema row): ~30–39h**

## Provenance System

| Task | Status | Est. hours |
|---|---|---|
| Three-value schema, decision, schema addition | Done | 0 |
| Default-behavior correction | **Done** (Sheet said Not Implemented) | 0 |
| Accept-suggestion path audit | **Done** (Sheet said Not Implemented) | 0 |
| Manual test checklist | **Done** (written this session) | 0 — but budget 2h to actually run the 9 test cases |

**Subtotal: ~2h (execution only)**

## Itinerary Content Generation

| Task | Status | Est. hours |
|---|---|---|
| Issue: descriptions lack depth | Identified | 3–4 (prompt tuning + iteration, excludes Shilpa's review time) |
| Issue: dining recs lack visual hierarchy | Identified, possibly already addressed | 2 (verify against real output, adjust if needed) |
| Trace content prompt logic | **Done** (written this session) | 0 |
| Trace docx template row rendering | **Done** (written this session) | 0 |
| Trace provenance-stamping intersection | **Done** (written this session) | 0 |
| Fix implementation (both issues) | Unblocked, not started | 4–6 (includes testing against a sample itinerary) |

**Subtotal: ~9–12h**

## Email Pipeline

| Task | Status | Est. hours |
|---|---|---|
| Remove email→client creation | Done | 0 |
| Remove email→booking creation | Done | 0 |
| Retain email-to-existing-record matching | Done | 0 |
| Thread-linking decision | Open — **decision, not engineering** | 0.5–1 (discussion time) |
| Wire matching to `resolveClient()`/`resolveBooking()` | Blocked on decision above | 4–6 |

**Subtotal: ~4.5–7h**

## Rate Sourcing Layer / Offline Rates Module

| Task | Status | Est. hours |
|---|---|---|
| RateSource abstraction design | Claimed Done, no code found | 3–4 (if actually building the interface, not just re-documenting a decision) |
| Priority order decision | Decided | 0 |
| Hotelbeds sandbox adapter | Claimed "In Use," no code found | **Confirm with Vijay first** — 6–8 if building from scratch |
| Bedbank-cheaper-than-GDS flag logic | Not defined, needs threshold decision first | 0.5 (decision) + 2–3 (build) |
| Sabre adapter | Blocked — external credentials | 10–14 once unblocked |
| Hotelbeds adapter rewrite (post-Sabre) | Not started | 3–4 |
| Offline Rates spec + config lists | Done (spec) | 0 |
| Offline Rates build module | Not started | 6–8 |

**Subtotal (excluding Sabre-blocked + unconfirmed Hotelbeds): ~15–19h**
**+ 10–14h once Sabre credentials land, + 6–8h if Hotelbeds needs building from scratch**

## Client-Facing Agents

| Task | Status | Est. hours |
|---|---|---|
| Channel decision | Locked | 0 |
| Trip Curator agent (discovery, read-only) | Designed | 8–10 |
| Trip Assistant agent (booking execution) | Designed, blocked on Sabre creds | 10–12 — **recommend Vijay reviews before this touches live bookings regardless of who builds it** |
| Curator→Assistant handoff | Designed | 4–6 |
| Backward navigation + pending-booking flag | Designed | 4–5 |
| System-prompt / voice-guideline doc | Not written | 3–4 (writing, not code) |

**Subtotal: ~29–37h**

## Client Task Management System

| Task | Status | Est. hours |
|---|---|---|
| 33-task master list, 5 priority tasks, digest approach, scope | Done/Agreed | 0 |
| Build | Not started | 10–12 |

**Subtotal: ~10–12h**

## Rate Assistant (separate from KB)

| Task | Status | Est. hours |
|---|---|---|
| Concept | Done | 0 |
| Scoping | Not started | 2–3 |
| Build | Not started, depends on scoping | TBD post-scoping |

**Subtotal: ~2–3h (excl. TBD build)**

## Build Tracker

| Task | Status | Est. hours |
|---|---|---|
| Structure design | Done | 0 |
| Authoritativeness convention | Needs confirmation — **decision, not engineering** | 0.5 |
| Codebase scan + Drive cross-reference | **Done** (this session) | 0 |
| Generate `BUILD_TRACKER.md` | **Done** (this session) | 0 |

## Open / Miscellaneous

| Task | Status | Est. hours |
|---|---|---|
| Ambiguous duplicate bookings (manual review) | Open | 2–4 (ops/data review, not engineering) |
| Sabre developer credentials | Blocked, external | Not an hours estimate — vendor-dependent, likely weeks not hours |

---

## Rough total

Summing confirmed-scope engineering work (excluding the Atlas KB schema TBD, Sabre-blocked
adapters, and post-scoping Rate Assistant build): **~105–135 hours**, or roughly **3–3.5
weeks** of one experienced engineer working solo, before any of the deliberately-deferred
items (Sabre integration once unblocked, Trip Assistant agent, Client Task Management
build).
