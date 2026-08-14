# PureLuxe Client-Facing Demo — Build Brief

**Status:** Locked decisions from Claude chat, ready for scoped Claude Code sessions with Vijay.
**Purpose:** A real, working demo of the client-facing PureLuxe product inside the actual repo. Uses mock rate/availability data (Sabre/Hotelbeds credentials still pending) but real agent logic, real orchestration code, and a real UI — so nothing here is throwaway. When live credentials land, only the adapter swaps.

---

## 1. Where it lives

- New route group: `/app/client/*` (or `/app/(client)/*`)
- Fully separate from Studio (`/app/studio` or wherever Studio currently lives) — no shared layout, no shared nav
- Shares: Supabase client, `resolveClient()` / `resolveTrip()` helpers, Anthropic SDK setup, iron-session pattern (see Auth below)
- Does NOT share: Studio's admin UI, Studio's write permissions to bookings/trips as an advisor would use them

## 2. Layout — Claude-like

Three columns: trip list (left), chat (center), itinerary/rates (right).

- **Left sidebar — trip list, collapsible:**
  - "New trip" button at top — starts a new chat and creates a new trip via `resolveTrip()`. One trip = one chat thread, always.
  - Below it, the client's trips listed as chats, most recent first — same pattern as claude.ai's chat history. Each entry auto-titles itself once the Curator knows enough (e.g. "Maldives, October" once destination + rough dates are known) — before that, "New trip" as a placeholder title, same idea as Claude's own auto-titling.
  - Selecting a trip loads that trip's message history plus its itinerary/rates sidebar state — switching trips is switching context entirely, not a filter on one long chat.
  - Guest profile entry pinned at the bottom (avatar + name) — opens the profile panel (see below).
- **Center — chat column:** message list + input pinned to bottom, as before.
- **Right sidebar — itinerary/rates, collapsible, opens automatically the first time there's something to show:**
  - **Itinerary** — day-by-day, updates as Curator refines the trip
  - **Rates** — grouped by property, each property showing multiple bookable options (room category/package) as collapsed cards — name + total only. Tapping a card expands it to show the full breakdown (room rate, resort fee, transfers, per the existing destination-level fee config). Multiple properties can be under comparison at once, each with its own set of option cards — the client may be weighing two resorts against each other, not just two room types at one resort.
  - One option can carry a "leaning towards this" indicator without removing the others — nothing is committed until the client actually books. **Default behavior (flag for override):** the Curator agent sets this based on how the conversation is going (client showing more interest in one), and the client can also tap a card to set it explicitly, which overrides the agent's inference. If you'd rather this only ever be client-set, that's a small change to §4 agent tool access.
- **Sidebar updates live/streaming** as the Curator agent talks — not snapped in only on completion. Sidebar state is driven off the same stream the chat UI consumes (tool-call results as they land), not a separate "finalize" step.
- **Chat and sidebar split responsibilities on rates:** chat narrates trade-offs in plain language ("the residence is $2k more but sleeps four"); the sidebar holds the structured, persistent numbers so nothing gets lost once the conversation scrolls past it. Full breakdowns belong in the sidebar, not as chat bubbles.
- No standalone "generate itinerary/rate doc" button in this product — the right sidebar IS the itinerary/rate sheet. Document generation is reserved for confirmations only (see §5).

## 2a. Guest profile

- Opens as a panel (or modal — pick whichever matches how Studio already handles similar panels) from the left sidebar
- Fields: name, email (from Google profile), phone, travel preferences (free text or structured tags — e.g. dietary, seating, room preferences), passport/ID details, loyalty program numbers
- **Not just decorative** — profile fields are passed into Curator/Assistant context so the agent can actually use them (e.g. suggest aisle seating, mention a dietary note when recommending a restaurant), consistent with the `advisor_take` personalization philosophy already used elsewhere
- **Demo data only** — since there's one shared demo persona (§6), profile fields hold placeholder/fake data, never a real person's actual passport or ID info. Real encryption-at-rest / PII handling for this data is a production concern, explicitly out of scope for the demo.

## 3. Mock rate/availability layer

- Build as a fourth adapter conforming to the existing `RateSourceRegistry` interface: `mockAdapter`
- Lives alongside `hotelbedsAdapter` / `gdsAdapter` stubs, same directory
- **No fixed property list.** Any property name the client mentions gets plausible generated data: multiple bookable options (room categories/packages) per property, each with its own pricing, availability
- Generation is seeded and deterministic within a conversation: hash of (property name + dates + guest count) → seed. First time a property is mentioned, a Haiku call generates its data (room types, price band, description) keyed to that seed; the result is cached (session-scoped, in-memory or a lightweight table) so repeat queries about the same property in the same conversation return consistent numbers rather than re-randomizing
- Destination-level fee config (resort fees, Maldives transfers) still applies on top of generated base rates, same as production logic
- `resolveRateSelection()` and `resolveRateRouting()` run unmodified against this adapter — Path 5 (offline/wholesale-first for high-value destinations) gets exercised for real in the demo, not faked. Path 5's destination/property matching (`high_value_routing` config) still needs a way to decide if a *generated* property counts as "high-value" — simplest: match on destination only (e.g. any Maldives property triggers Path 5), not a specific property whitelist
- Swapping in live Hotelbeds/Sabre later = config change (registry swap), not a rewrite

## 4. Agent behavior — real, not scripted

- Trip Curator and Trip Assistant run as real Claude API calls with real tool use (KB lookup via Atlas, rate lookup via `mockAdapter`)
- Nothing in the conversation is a canned script — only the underlying rate numbers are mocked
- Curator → Assistant handoff logic gets built for real (invisible to client, one continuous voice, per existing design) — cheap to do now, expensive to retrofit later
- Backward navigation unblocked; Assistant surfaces a flag if the client pivots away from a property with a pending mock booking (per existing design)

## 5. Document generation — confirmations only

- Single trigger: client confirms a mock booking in-chat
- Ports a trimmed version of `generate-v2.js`, scoped to a confirmation template only (not the full itinerary doc — that stays Studio's job)
- Output: downloadable PDF/docx surfaced directly in chat

## 6. Auth

- Reuses Google OAuth already configured in the codebase
- **Separate session/permission scope from Studio** — demo/client login must NOT inherit any advisor or admin permissions. Needs its own session cookie or scope claim distinguishing "client" from "advisor."
- **Identity binding:** any Google account that logs in maps to a single shared demo client persona — one dedicated demo record in `families`/`family_members` created for this purpose. No trip history seeding at this stage — the persona exists just to give the session an identity to attach trips/bookings to as they're created during the demo. Binding a Google login to the *actual* person's real family record is a small follow-on if ever needed, not part of this build.

## 7. Data writes

- Demo writes to the real Supabase tables (`trips`, `bookings`, etc.) via the existing `resolveClient()`/`resolveTrip()`/`resolveBooking()` resolvers, unmodified
- **New table needed:** `client_chat_messages` (or similar) — `trip_id`, `role`, `content`, `tool_calls` (jsonb), `created_at`. This didn't exist before because Studio doesn't have a client-facing chat thread concept; one trip = one persisted conversation now, so this table is required, not optional
- All demo-generated rows (trips, bookings, chat messages) flagged with an `is_demo` boolean so they can be filtered out of real reporting/dashboards
- Simpler than a parallel mock data store and keeps the demo on the exact same code path production will use

## 8. Explicitly out of scope for this demo

- Real payments
- Real Sabre/Hotelbeds calls
- Full membership/signup flows
- Task management system (33-task journey)
- AI DMC layer

---

## Suggested session scoping

Per usual discipline — one numbered step per Claude Code session, review before proceeding:

1. **Route/layout shell** — `/app/client` scaffold, three-column layout (trip list sidebar, chat column, itinerary/rates sidebar), guest profile panel shell, no agent logic yet, static mock content throughout to prove the layout
2. **`mockAdapter` + wire into existing `RateSourceRegistry`** — seeded generation, session-scoped caching, prove `resolveRateSelection()`/`resolveRateRouting()` work end-to-end including Path 5 behavior on generated properties
3. **Trip Curator agent wiring** — real Claude calls + KB tool use + mock rate tool use, streaming into chat and sidebar
4. **Trip Assistant handoff + mock booking flow** — writes to real Supabase tables with `is_demo` flag
5. **Confirmation document generation**
6. **Auth wiring** — Google OAuth, single shared demo persona, separate session scope from Studio; includes creating the one demo `families` record (no trip history seeding needed)

---

## Decisions locked

All open questions from the prior draft are resolved (§3 property generation, §6 identity binding, §7 data writes). One product decision in §2 is a stated default, not yet confirmed by Keshav: whether "leaning towards this" can be agent-inferred or must always be client-set. Confirm before Session 3 (agent wiring) — everything else, including Session 1 and 2, can start now.

A static HTML mockup of the sidebar/chat layout (`pureluxe-client-ui-mockup.html`) exists for visual reference — not code to port, just to see the shape before building.
