# Itinerary Content Generation — End-to-End Trace

Covers Build Tracker rows "Trace content prompt logic," "Trace docx template row
rendering," and "Trace provenance-stamping intersection" (Itinerary Content Generation).
Written by reading the actual code paths — `lib/trip-builder/agent.ts`, `tools.ts`,
`kb-tool.ts`, `document-assembler.ts`, `docx-builder.ts` — not the original spec.

## 1. Content prompt logic

Two prompts produce itinerary content, both in `lib/trip-builder/agent.ts`:

- **`POST_TRIP_SYSTEM_PROMPT`** (agent.ts:45-66) — the chat agent's system prompt. The
  depth instruction is explicit, at line 55: "`save_itinerary_day` items need real depth,
  not bare labels... don't compress '[detailed suggestion]' down to just the restaurant's
  name... give enough timing/pacing guidance to be useful... plus a short reason it's worth
  doing." It also mandates calling `request_suggestion` before writing any named
  recommendation (line 54), and gives per-item-type rules (line 58) for what renders inline
  vs. gets collected separately.
- **`generateGeneralSuggestion`'s system prompt** (`kb-tool.ts:82`) — used only for the
  `llm_general` fallback path. Also asks for "specific, concrete, luxury-oriented
  recommendations — named restaurants and experiences with detail, not generic filler."

**Relative to the Sheet's "descriptions lack depth" issue:** both prompts already
explicitly instruct for depth — this isn't an untouched/naive prompt. If the issue is still
live, the prompt text itself isn't the obvious cause; more likely candidates are (a) the
model not reliably following the instruction under the full system prompt's other
competing rules, or (b) content getting saved via the `advisor_manual` path (no
`request_suggestion` call at all, so no generated detail to carry forward — just whatever
the advisor typed). Confirming which requires reading actual saved output, not the prompt
in isolation.

## 2. Docx template row rendering

Full path from DB to rendered document:

```
trip_itinerary_days.items (jsonb: [{type, text}])
  → document-assembler.ts: assembleDocumentData()
      - filters out type 'alt'/'casual' from the inline day list
      - prefixes the rest by type: 'confirmed' → "› ...", 'hotel' → "HOTEL: ...",
        'dining' → "DINING: ...", 'note' → "NOTE: ..." (assembler.ts:191-198)
      - 'alt'/'casual' items are pulled into `diningRecommendations`, grouped per leg
        (assembler.ts:202-214), tagged with their tier ('alt' | 'casual')
  → docx-builder.ts
      - inline day items render with type-specific weight (hotel gets brass emphasis,
        dining gets bold+shaded — see the item legend built around docx-builder.ts:732)
      - diningRecommendations renders as a separate section per leg, with 'alt' items
        marked '◦' and 'casual' items marked '·' in different greys (docx-builder.ts:756-771)
```

This already gives dining recs visual hierarchy by tier (alt vs. casual get distinct
glyphs/colors, and the anchor 'dining' item is bold+shaded inline vs. everything else being
plain). **Relative to the Sheet's "dining recs lack visual hierarchy by tier" issue:** this
looks addressed, or at least partially — worth an actual rendered-document check against
whatever specifically prompted that issue being filed, since "distinct visual weight" could
still fall short of whatever bar was originally meant (e.g. if the complaint was about
*content* tier — dining quality/price tier — rather than the alt/casual *mention* tier this
code distinguishes; those are different meanings of "tier" and worth clarifying which one
the original issue meant).

## 3. Provenance-stamping intersection with content generation

Full stamping path (see `docs/provenance-manual-test-checklist.md` for the closure/turn
mechanics):

```
request_suggestion tool call
  → kb-tool.ts: getKBSuggestion() tags result 'kb' or 'llm_general' at generation time
  → tools.ts: lastSuggestionSource closure var holds it
save_itinerary_day tool call
  → tools.ts:391: source = lastSuggestionSource ?? 'advisor_manual'
  → written to trip_itinerary_days.source (migration 015: CHECK constrained to
    'kb' | 'llm_general' | 'advisor_manual')
```

**Where it stops:** `document-assembler.ts`'s `assembleDocumentData()` reads
`trip_itinerary_days.items` and `.title`/`.date` etc., but **never reads `.source` or
`.verified`** onto `DayEntry` or anywhere else in `TripDocumentData`. Provenance is stamped
and stored, but it is invisible in the generated client document and in the rate
sheet — it exists purely as an internal/backend field.

This may well be intentional (a client-facing luxury travel document plausibly shouldn't
show "AI-generated" tags), but it means the provenance system currently has no visible
effect on anything an advisor or client sees — it's pure audit trail. Worth confirming with
Keshav whether that's the intended end state, or whether provenance was meant to surface
somewhere (an internal-only view, an advisor-facing badge in the sidebar before the
document is generated, etc.) that doesn't exist yet.
