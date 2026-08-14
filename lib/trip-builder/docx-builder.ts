// PureLuxe trip document builder — ported from the reviewed prototype
// (generate-v2.js, from the design scoping conversation that produced the
// Trip Builder build brief). Styling, colors, table layouts, and card
// structure are unchanged from that prototype; only the input now comes
// from assembleDocumentData() (querying the DB) instead of a hand-written
// JSON file, and the output is returned as a Buffer instead of written to
// disk via a CLI.
//
// Three deliberate additions beyond a verbatim port, all in the same spirit
// as the prototype's own `if (data.legs && data.legs.length > 0)` guard
// around the Rate Options / Flights / Investment Summary block: the
// "JOURNEY AT A GLANCE" section, the "DAY BY DAY ITINERARY" section, and
// the item legend are now each skipped when there's no day content to show
// them for. This is what makes a rate-sheet-only document (generated when
// there's no itinerary content yet) not render an empty itinerary section
// — the prototype was never exercised with itinerary-less input, since its
// sample data always had both tracks filled in.

import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType,
  VerticalAlign, Header, Footer, ImageRun,
} from 'docx'
import fs from 'fs'
import path from 'path'

// ── Input shape ──────────────────────────────────────────────────────────

// One flight number's worth of a fare — see rate-extraction.ts's identical
// (snake_case) type for why this exists: a connection/multi-city fare is
// one line item and one price, but each flight number gets its own row in
// the rendered table rather than being squashed into one "Details" sentence.
export interface FlightSegment {
  flightNumber: string | null
  route:        string
  date:         string | null
  departure:    string | null
  arrival:      string | null
  duration:     string | null
  stops:        string | null
  aircraft:     string | null
  notes:        string | null
}

export interface LineItemSpec {
  title:            string
  subtitle?:        string | null
  unit:             'night' | 'person' | 'flat'
  quantity:         number
  ratePerUnit:      number
  currency:         string
  details?:         string | null
  inclusions?:      string[]
  cancellation?:    string | null
  pending:          boolean
  selected?:        boolean
  // ratePerUnit is always displayed exactly as quoted — tax and room/unit
  // count are applied only when computing the subtotal, never folded into
  // the displayed rate itself. See itemSubtotal().
  taxPercentage?:   number | null
  unitCount?:       number
  // Trip-level items are usually flights, tagged FLIGHT by default — but a
  // transfer can also be trip-level (spans legs, per the schema), so this
  // lets the assembler correct the tag rather than mislabel it FLIGHT.
  typeTagOverride?: string
  // Category "flight" only — when present, rendered as its own table
  // instead of (or alongside, for non-per-segment leftovers) `details`.
  segments?:        FlightSegment[] | null
}

export interface LegRateOptions {
  name:       string
  dateRange?: string
  categories: {
    accommodation?: LineItemSpec[]
    activities?:    LineItemSpec[]
    transfers?:     LineItemSpec[]
  }
}

export interface DayEntry {
  dayNum:   number
  date:     string
  location: string
  hotel?:   string | null
  title:    string
  items:    string[] // pre-prefixed: "› ...", "HOTEL: ...", "DINING: ...", "NOTE: ..." — no ALT:/CASUAL:, those render in diningRecommendations instead
}

// Secondary ("alt") and casual/backup dining mentions, pulled out of the
// day cards and grouped per leg — so a light day with several dining
// mentions doesn't bury its one anchor pick under a wall of bullets. Only
// the day's anchor "dining" item (and any "confirmed" reservation) stays
// inline on the day card; everything else lands here.
export interface LegDiningBlock {
  legName: string
  items:   { tier: 'alt' | 'casual'; text: string }[]
}

export interface TripDocumentData {
  title:                 string
  subtitle:              string
  dates:                 string
  guests:                string
  glance:                [string, string, string, string][]
  days:                  DayEntry[]
  diningRecommendations: LegDiningBlock[]
  notes:                 string[]
  legs:                  LegRateOptions[]
  flights:               LineItemSpec[]
}

// ── Colour palette (B&W, brass accent) ──────────────────────────────────

const CHARCOAL    = '1A1A1A'
const DARK_GREY   = '333333'
const MID_GREY    = '666666'
const LIGHT_GREY  = 'F2F2F2'
const WHITE       = 'FFFFFF'
const RULE_GREY   = 'AAAAAA'
const DINING_BG   = 'E8E8E8'
const DINING_TEXT = '1A1A1A'
const BRASS       = 'A9793F'
const BRASS_BG    = 'F4EBDD'

const makeBorder  = (color = RULE_GREY) => ({ style: BorderStyle.SINGLE, size: 1, color })
const makeBorders = (color = RULE_GREY) => {
  const b = makeBorder(color)
  return { top: b, bottom: b, left: b, right: b }
}
const borders = makeBorders()

function spacer(before = 100, after = 100) {
  return new Paragraph({ spacing: { before, after }, children: [new TextRun('')] })
}

function sectionTitle(text: string) {
  return new Paragraph({
    spacing: { before: 320, after: 120 },
    children: [new TextRun({ text, bold: true, size: 26, font: 'Arial', color: CHARCOAL })],
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: CHARCOAL, space: 4 } },
  })
}

function noteText(text: string) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text: `• ${text}`, size: 18, font: 'Arial', color: MID_GREY, italics: true })],
  })
}

function legendItem(prefix: string, color: string, label: string) {
  return new Paragraph({
    spacing: { before: 40, after: 40 },
    children: [
      new TextRun({ text: `${prefix}  `, bold: true, size: 20, font: 'Arial', color }),
      new TextRun({ text: label, size: 19, font: 'Arial', color: DARK_GREY }),
    ],
  })
}

// ── Day card ─────────────────────────────────────────────────────────────

// accommodationDisplay() (document-assembler.ts) encodes an undecided hotel
// as "TBC\n<option 1>\n<option 2>\n..." instead of a vague "Hotel TBD (5
// options)" that named none of them — split that back out into one
// paragraph per line here, on the day card's dark header background.
function hotelHeaderParagraphs(hotel: string) {
  const lines = hotel.split('\n')
  if (lines.length === 1) {
    return [new Paragraph({ children: [new TextRun({ text: hotel, size: 17, font: 'Arial', color: 'AAAAAA', italics: true })] })]
  }
  const [label, ...options] = lines
  return [
    new Paragraph({ children: [new TextRun({ text: label, size: 17, font: 'Arial', color: 'D9BE8F', bold: true })] }),
    ...options.map(o => new Paragraph({ spacing: { before: 10 }, children: [new TextRun({ text: o, size: 15, font: 'Arial', color: 'AAAAAA', italics: true })] })),
  ]
}

function dayCard(dayNum: number, date: string, location: string, hotel: string | null | undefined, title: string, items: string[]) {
  const headerRow = new TableRow({
    children: [
      new TableCell({
        borders,
        width: { size: 1300, type: WidthType.DXA },
        shading: { fill: CHARCOAL, type: ShadingType.CLEAR },
        margins: { top: 120, bottom: 120, left: 160, right: 120 },
        verticalAlign: VerticalAlign.CENTER,
        children: [
          new Paragraph({ children: [new TextRun({ text: `Day ${dayNum}`, bold: true, size: 22, font: 'Arial', color: WHITE })] }),
          new Paragraph({ children: [new TextRun({ text: date, size: 17, font: 'Arial', color: 'BBBBBB' })] }),
        ],
      }),
      new TableCell({
        borders,
        width: { size: 8060, type: WidthType.DXA },
        shading: { fill: CHARCOAL, type: ShadingType.CLEAR },
        margins: { top: 120, bottom: 120, left: 160, right: 160 },
        verticalAlign: VerticalAlign.CENTER,
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: location.toUpperCase(), bold: true, size: 18, font: 'Arial', color: 'AAAAAA', characterSpacing: 40 }),
              new TextRun({ text: '  ·  ', size: 18, font: 'Arial', color: '666666' }),
              new TextRun({ text: title, bold: true, size: 22, font: 'Arial', color: WHITE }),
            ],
          }),
          ...(hotel ? hotelHeaderParagraphs(hotel) : []),
        ],
      }),
    ],
  })

  const contentRows = items.map((item, i) => {
    const isHotel  = item.startsWith('HOTEL:')
    const isDining = item.startsWith('DINING:')
    const isNote   = item.startsWith('NOTE:')
    const text     = item.replace(/^(HOTEL:|DINING:|NOTE:)\s*/, '')

    const shade = i % 2 === 0 ? LIGHT_GREY : WHITE
    const bg = isHotel ? BRASS_BG : isDining ? DINING_BG : shade
    let prefix      = '›'
    let prefixColor = CHARCOAL
    let textColor   = DARK_GREY
    let italic      = false
    let bold        = false
    const size      = 19

    // Only the property highlight and the day's one anchor dining pick
    // (or an actually confirmed reservation) render inline — secondary/
    // casual dining mentions never reach this function at all; the
    // assembler routes them into diningRecommendations instead, which is
    // what keeps a busy free day from turning into a wall of bullets.
    if (isHotel)  { prefix = '★'; prefixColor = BRASS;    textColor = CHARCOAL;  bold = true }
    if (isDining) { prefix = '♦'; prefixColor = CHARCOAL; textColor = DINING_TEXT; bold = true }
    if (isNote)   { prefix = '✦'; prefixColor = DARK_GREY; textColor = MID_GREY;   italic = true }

    return new TableRow({
      children: [
        new TableCell({
          borders,
          width: { size: 1300, type: WidthType.DXA },
          shading: { fill: bg, type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 80, left: 160, right: 120 },
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: prefix, size: 22, font: 'Arial', color: prefixColor, bold })],
          })],
        }),
        new TableCell({
          borders,
          width: { size: 8060, type: WidthType.DXA },
          shading: { fill: bg, type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 80, left: 160, right: 160 },
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({
            children: [new TextRun({ text, size, font: 'Arial', color: textColor, italics: italic, bold })],
          })],
        }),
      ],
    })
  })

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [1300, 8060],
    rows: [headerRow, ...contentRows],
  })
}

// ── Glance table ─────────────────────────────────────────────────────────

// Same "TBC\n<options>" split as hotelHeaderParagraphs, styled for the
// glance table's light background instead of the day card's dark one.
function hotelCellParagraphs(text: string, alignment: (typeof AlignmentType)[keyof typeof AlignmentType]) {
  const lines = text.split('\n')
  if (lines.length === 1) {
    return [new Paragraph({ alignment, children: [new TextRun({ text, size: 19, font: 'Arial', color: DARK_GREY })] })]
  }
  const [label, ...options] = lines
  return [
    new Paragraph({ alignment, children: [new TextRun({ text: label, size: 19, font: 'Arial', color: BRASS, bold: true })] }),
    ...options.map(o => new Paragraph({ alignment, spacing: { before: 20 }, children: [new TextRun({ text: o, size: 16, font: 'Arial', color: MID_GREY })] })),
  ]
}

function glanceTable(rows: [string, string, string, string][]) {
  const colWidths = [1400, 1800, 2000, 4160]
  const headers   = ['Dates', 'Destination', 'Hotel', 'Highlights']
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((text, i) =>
          new TableCell({
            borders,
            width: { size: colWidths[i], type: WidthType.DXA },
            shading: { fill: CHARCOAL, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text, bold: true, color: WHITE, size: 20, font: 'Arial' })],
            })],
          }),
        ),
      }),
      ...rows.map((row, i) =>
        new TableRow({
          children: row.map((text, j) => {
            const alignment = j < 2 ? AlignmentType.CENTER : AlignmentType.LEFT
            return new TableCell({
              borders,
              width: { size: colWidths[j], type: WidthType.DXA },
              shading: { fill: i % 2 === 0 ? LIGHT_GREY : WHITE, type: ShadingType.CLEAR },
              margins: { top: 90, bottom: 90, left: 120, right: 120 },
              children: j === 2
                ? hotelCellParagraphs(text, alignment)
                : [new Paragraph({
                    alignment,
                    children: [new TextRun({ text, size: 19, font: 'Arial', color: DARK_GREY, bold: j === 1 })],
                  })],
            })
          }),
        }),
      ),
    ],
  })
}

// ── Flight segments table (one row per flight number) ──────────────────

function segmentsTable(segments: FlightSegment[]) {
  const colWidths = [900, 1760, 1200, 1600, 900, 1200, 1800]
  const headers   = ['Flight', 'Route', 'Date', 'Time', 'Duration', 'Stops', 'Aircraft']

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((text, i) => new TableCell({
      borders,
      width: { size: colWidths[i], type: WidthType.DXA },
      shading: { fill: 'ECECEC', type: ShadingType.CLEAR },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 15, font: 'Arial', color: MID_GREY })] })],
    })),
  })

  const bodyRows: TableRow[] = []
  segments.forEach((seg, i) => {
    const bg = i % 2 === 0 ? WHITE : LIGHT_GREY
    const cells = [
      seg.flightNumber ?? '—',
      seg.route,
      seg.date ?? '—',
      seg.departure || seg.arrival ? `${seg.departure ?? '?'}–${seg.arrival ?? '?'}` : '—',
      seg.duration ?? '—',
      seg.stops ?? '—',
      seg.aircraft ?? '—',
    ]
    bodyRows.push(new TableRow({
      children: cells.map((text, j) => new TableCell({
        borders,
        width: { size: colWidths[j], type: WidthType.DXA },
        shading: { fill: bg, type: ShadingType.CLEAR },
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({ children: [new TextRun({ text, size: 16, font: 'Arial', color: DARK_GREY })] })],
      })),
    }))
    if (seg.notes) {
      bodyRows.push(new TableRow({
        children: [new TableCell({
          borders,
          columnSpan: 7,
          width: { size: 9360, type: WidthType.DXA },
          shading: { fill: bg, type: ShadingType.CLEAR },
          margins: { top: 20, bottom: 60, left: 100, right: 100 },
          children: [new Paragraph({ children: [new TextRun({ text: seg.notes, italics: true, size: 15, font: 'Arial', color: MID_GREY })] })],
        })],
      }))
    }
  })

  return new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: colWidths, rows: [headerRow, ...bodyRows] })
}

// ── Line item card — generic across accommodation/flights/activities/transfers ──

function lineItemCard(label: string, typeTag: string, item: LineItemSpec) {
  const rows: TableRow[] = []

  rows.push(new TableRow({
    children: [
      new TableCell({
        borders,
        width: { size: 9360, type: WidthType.DXA },
        columnSpan: 2,
        shading: { fill: CHARCOAL, type: ShadingType.CLEAR },
        margins: { top: 120, bottom: 120, left: 160, right: 160 },
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: `${typeTag}  ·  ${label}  ·  `, bold: true, size: 17, font: 'Arial', color: 'D9BE8F' }),
              new TextRun({ text: item.title, bold: true, size: 22, font: 'Arial', color: WHITE }),
            ],
          }),
          ...(item.subtitle ? [new Paragraph({
            spacing: { before: 20 },
            children: [new TextRun({ text: item.subtitle, size: 18, font: 'Arial', color: 'BBBBBB', italics: true })],
          })] : []),
        ],
      }),
    ],
  }))

  const infoRow = (label: string, value: string, i: number, bold = false) => new TableRow({
    children: [
      new TableCell({
        borders,
        width: { size: 2600, type: WidthType.DXA },
        shading: { fill: i % 2 === 0 ? LIGHT_GREY : WHITE, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 160, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: label, size: 18, font: 'Arial', color: MID_GREY })] })],
      }),
      new TableCell({
        borders,
        width: { size: 6760, type: WidthType.DXA },
        shading: { fill: i % 2 === 0 ? LIGHT_GREY : WHITE, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 160, right: 160 },
        children: [new Paragraph({ children: [new TextRun({ text: value, size: 19, font: 'Arial', color: bold ? BRASS : DARK_GREY, bold })] })],
      }),
    ],
  })

  if (item.pending) {
    rows.push(infoRow('Rate', 'Pending — awaiting supplier confirmation', 1))
  } else {
    const currency = item.currency || 'USD'
    // The rate line always shows the per-unit rate exactly as quoted — tax
    // and room/unit count are noted alongside it, never folded into this
    // number, so it stays traceable to what the supplier actually quoted.
    let rateLine: string
    if (item.unit === 'night') {
      rateLine = `${currency} ${item.ratePerUnit.toLocaleString()} / night  ·  ${item.quantity} nights`
    } else if (item.unit === 'person') {
      rateLine = `${currency} ${item.ratePerUnit.toLocaleString()} / person  ·  ${item.quantity} travelers`
    } else {
      rateLine = `${currency} ${item.ratePerUnit.toLocaleString()} flat rate`
    }
    if (item.unitCount && item.unitCount !== 1) rateLine += `  ·  ${item.unitCount} rooms`
    if (item.taxPercentage) rateLine += `  ·  +${item.taxPercentage}% tax`

    const taxSuffix = item.taxPercentage ? ' (incl. tax)' : ''
    const hasMultipleUnits = !!item.unitCount && item.unitCount !== 1

    rows.push(infoRow('Rate', rateLine, 1))
    if (item.segments && item.segments.length) {
      rows.push(new TableRow({
        children: [new TableCell({
          borders,
          columnSpan: 2,
          width: { size: 9360, type: WidthType.DXA },
          margins: { top: 60, bottom: 60, left: 0, right: 0 },
          children: [segmentsTable(item.segments)],
        })],
      }))
      if (item.details) rows.push(infoRow('Other details', item.details, 2))
    } else if (item.details) {
      rows.push(infoRow('Details', item.details, 2))
    }
    if (item.inclusions && item.inclusions.length) rows.push(infoRow('Inclusions', item.inclusions.join('   ·   '), 3))
    if (item.cancellation) rows.push(infoRow('Cancellation policy', item.cancellation, 4))
    if (hasMultipleUnits) {
      rows.push(infoRow(`Subtotal per room${taxSuffix}`, `${currency} ${itemSubtotalPerUnit(item).toLocaleString()}`, 5))
      rows.push(infoRow(`Subtotal — ${item.unitCount} rooms${taxSuffix}`, `${currency} ${itemSubtotal(item).toLocaleString()}`, 6, true))
    } else {
      rows.push(infoRow(`Subtotal${taxSuffix}`, `${currency} ${itemSubtotal(item).toLocaleString()}`, 5, true))
    }
  }

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [2600, 6760],
    rows,
  })
}

// Tax-inclusive total for ONE room/unit (rate x quantity, then tax) —
// deliberately excludes unitCount, so a multi-room item can show "per room"
// and "all rooms" as two distinct, individually tax-inclusive figures
// rather than only the combined total.
function itemSubtotalPerUnit(item: LineItemSpec): number {
  if (item.pending) return 0
  const base = item.unit === 'flat' ? item.ratePerUnit : item.ratePerUnit * item.quantity
  return item.taxPercentage ? base * (1 + item.taxPercentage / 100) : base
}

// The full total across every room/unit needed. ratePerUnit itself always
// stays exactly as quoted (see LineItemSpec) — this is the only place tax
// and unitCount actually apply to the total.
function itemSubtotal(item: LineItemSpec): number {
  return itemSubtotalPerUnit(item) * (item.unitCount || 1)
}

// ── Category block (Accommodation/Activities/Transfers within a leg) ────

function categoryBlock(categoryLabel: string, typeTag: string, items: LineItemSpec[]) {
  const blocks: (Paragraph | Table)[] = []
  blocks.push(new Paragraph({
    spacing: { before: 140, after: 80 },
    children: [new TextRun({ text: categoryLabel, bold: true, size: 19, font: 'Arial', color: MID_GREY })],
  }))
  items.forEach((item, i) => {
    const label = items.length > 1 ? `Option ${String.fromCharCode(65 + i)}` : 'Rate'
    blocks.push(lineItemCard(label, typeTag, item))
    blocks.push(spacer(60, 0))
  })
  if (items.length > 1 && !items.some(o => o.selected)) {
    blocks.push(noteText(`${items.length} options presented for ${categoryLabel.toLowerCase()} — awaiting selection.`))
  }
  return blocks
}

// ── Rate options section (per leg) ──────────────────────────────────────

function legRateOptions(leg: LegRateOptions) {
  const blocks: (Paragraph | Table)[] = []
  const titleRuns = [new TextRun({ text: leg.name.toUpperCase(), bold: true, size: 21, font: 'Arial', color: CHARCOAL })]
  if (leg.dateRange) {
    titleRuns.push(new TextRun({ text: `   ·   ${leg.dateRange}`, size: 18, font: 'Arial', color: MID_GREY }))
  }
  blocks.push(new Paragraph({
    spacing: { before: 200, after: 60 },
    children: titleRuns,
    border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: RULE_GREY, space: 4 } },
  }))

  const cats = leg.categories || {}
  if (cats.accommodation?.length) blocks.push(...categoryBlock('Accommodation', 'STAY', cats.accommodation))
  if (cats.activities?.length)    blocks.push(...categoryBlock('Activities', 'ACTIVITY', cats.activities))
  if (cats.transfers?.length)     blocks.push(...categoryBlock('Transfers', 'TRANSFER', cats.transfers))

  return blocks
}

// ── Trip investment summary ─────────────────────────────────────────────

function investmentTable(legs: LegRateOptions[], flights: LineItemSpec[]) {
  const colWidths = [3600, 2400, 3360]
  const headers   = ['Item', 'Status', 'Subtotal']
  // Per-currency, not a single blended number — line items can span
  // currencies with no FX conversion in scope (same reasoning as the
  // sidebar's running_total_by_currency). The prototype this was ported
  // from hardcoded "USD" on the total row regardless of the items' actual
  // currency; harmless against its all-USD sample data, but wrong for any
  // trip priced in INR (PureLuxe's own common case) — fixed here.
  const grandTotalByCurrency: Record<string, number> = {}
  let anyExcluded = false
  const bodyData: [string, string, string, boolean][] = []

  const evalItems = (rowLabel: string, items: LineItemSpec[] | undefined) => {
    if (!items || items.length === 0) return
    const confirmed = items.filter(o => !o.pending)
    if (confirmed.length === 0) {
      anyExcluded = true
      bodyData.push([rowLabel, 'Pending', '—', false])
    } else if (confirmed.length > 1 && !confirmed.some(o => o.selected)) {
      anyExcluded = true
      bodyData.push([rowLabel, `${confirmed.length} options`, 'Awaiting selection', false])
    } else {
      const chosen = confirmed.length === 1 ? confirmed[0] : confirmed.find(o => o.selected)!
      const subtotal = itemSubtotal(chosen)
      const currency = chosen.currency || 'USD'
      grandTotalByCurrency[currency] = (grandTotalByCurrency[currency] ?? 0) + subtotal
      bodyData.push([rowLabel, chosen.title, `${currency} ${subtotal.toLocaleString()}`, true])
    }
  }

  legs.forEach(leg => {
    const cats = leg.categories || {}
    if (cats.accommodation?.length) evalItems(`${leg.name} — accommodation`, cats.accommodation)
    if (cats.activities?.length)    evalItems(`${leg.name} — activities`, cats.activities)
    if (cats.transfers?.length)     evalItems(`${leg.name} — transfers`, cats.transfers)
  })
  if (flights && flights.length) evalItems('Flights', flights)

  const bodyRows = bodyData.map(([label, status, value, isFinal], i) =>
    new TableRow({
      children: [label, status, value].map((text, j) =>
        new TableCell({
          borders,
          width: { size: colWidths[j], type: WidthType.DXA },
          shading: { fill: i % 2 === 0 ? LIGHT_GREY : WHITE, type: ShadingType.CLEAR },
          margins: { top: 90, bottom: 90, left: 140, right: 140 },
          children: [new Paragraph({
            alignment: j === 0 ? AlignmentType.LEFT : AlignmentType.CENTER,
            children: [new TextRun({
              text, size: 19, font: 'Arial',
              color: (!isFinal && j === 2) ? MID_GREY : DARK_GREY,
              italics: !isFinal && j === 2, bold: j === 0,
            })],
          })],
        }),
      ),
    }),
  )

  const currencies = Object.keys(grandTotalByCurrency).sort()
  // Only the very last total row gets the "Total trip investment" /
  // "Total so far" label — with multiple currencies, the rows above it
  // are unlabeled continuations of the same total, not separate totals.
  const totalRows = currencies.length
    ? currencies.map((currency, i) => {
        const isLast = i === currencies.length - 1
        const label = isLast ? (anyExcluded ? 'Total so far (excludes pending / unselected items)' : 'Total trip investment') : ''
        return new TableRow({
          children: [
            new TableCell({
              borders, width: { size: colWidths[0] + colWidths[1], type: WidthType.DXA },
              columnSpan: 2, shading: { fill: BRASS_BG, type: ShadingType.CLEAR },
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: label, bold: true, size: 20, font: 'Arial', color: '7A5726' })],
              })],
            }),
            new TableCell({
              borders, width: { size: colWidths[2], type: WidthType.DXA },
              shading: { fill: BRASS_BG, type: ShadingType.CLEAR },
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: `${currency} ${grandTotalByCurrency[currency].toLocaleString()}`, bold: true, size: 22, font: 'Arial', color: '7A5726' })],
              })],
            }),
          ],
        })
      })
    : [new TableRow({
        children: [
          new TableCell({
            borders, width: { size: colWidths[0] + colWidths[1], type: WidthType.DXA },
            columnSpan: 2, shading: { fill: BRASS_BG, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 140, right: 140 },
            children: [new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: 'Total trip investment', bold: true, size: 20, font: 'Arial', color: '7A5726' })],
            })],
          }),
          new TableCell({
            borders, width: { size: colWidths[2], type: WidthType.DXA },
            shading: { fill: BRASS_BG, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 140, right: 140 },
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: '—', bold: true, size: 22, font: 'Arial', color: '7A5726' })],
            })],
          }),
        ],
      })]

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((text, i) =>
          new TableCell({
            borders,
            width: { size: colWidths[i], type: WidthType.DXA },
            shading: { fill: CHARCOAL, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 140, right: 140 },
            children: [new Paragraph({
              alignment: i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER,
              children: [new TextRun({ text, bold: true, color: WHITE, size: 20, font: 'Arial' })],
            })],
          }),
        ),
      }),
      ...bodyRows,
      ...totalRows,
    ],
  })
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function buildTripDocumentBuffer(data: TripDocumentData): Promise<Buffer> {
  const logoPath = path.join(process.cwd(), 'lib', 'trip-builder', 'assets', 'pureluxe-logo.jpg')
  const logoImage = fs.existsSync(logoPath)
    ? new ImageRun({ data: fs.readFileSync(logoPath), transformation: { width: 130, height: 84 }, type: 'jpg' })
    : null

  const children: (Paragraph | Table)[] = []

  // Title block
  children.push(logoImage
    ? new Paragraph({ spacing: { before: 0, after: 120 }, children: [logoImage] })
    : spacer(0, 120))

  children.push(new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text: data.title, bold: true, size: 72, font: 'Arial', color: CHARCOAL })],
  }))
  children.push(new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text: `Luxury Journey  |  ${data.subtitle}`, size: 26, font: 'Arial', color: MID_GREY })],
  }))
  children.push(new Paragraph({
    spacing: { after: 40 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: CHARCOAL, space: 6 } },
    children: [new TextRun({ text: `${data.dates}  |  ${data.guests}  |  Proposed Itinerary for Discussion`, size: 21, font: 'Arial', color: MID_GREY })],
  }))

  const hasDays   = data.days && data.days.length > 0
  const hasGlance = data.glance && data.glance.length > 0
  // Not just data.legs.length: a trip whose rate items are all leg-less
  // (leg_id null — flights, or accommodation/activity items never assigned
  // to a leg) still has real rate content to show, just nothing that
  // grouped into a per-leg category block. Gating on legs alone silently
  // dropped the entire Rate Options/Flights/Investment Summary section
  // whenever every line item happened to lack a leg_id.
  const hasLegs   = (data.legs && data.legs.length > 0) || (data.flights && data.flights.length > 0)

  // Legend — only meaningful if day cards (which use these symbols) exist.
  if (hasDays) {
    children.push(spacer(80, 40))
    children.push(legendItem('›', CHARCOAL, 'Confirmed / included service'))
    children.push(legendItem('★', BRASS,     'Hotel highlight'))
    children.push(legendItem('♦', CHARCOAL, 'Anchor dining recommendation'))
    children.push(legendItem('✦', DARK_GREY, 'Important note'))
    children.push(spacer(80, 80))
  }

  // Glance
  if (hasGlance) {
    children.push(sectionTitle('JOURNEY AT A GLANCE'))
    children.push(spacer(80, 60))
    children.push(glanceTable(data.glance))
    children.push(spacer(200, 100))
  }

  // Days
  if (hasDays) {
    children.push(sectionTitle('DAY BY DAY ITINERARY'))
    children.push(spacer(80, 80))
    data.days.forEach((day, i) => {
      children.push(dayCard(day.dayNum, day.date, day.location, day.hotel, day.title, day.items))
      if (i < data.days.length - 1) children.push(spacer(160, 0))
    })
  }

  // Dining recommendations — secondary/casual mentions pulled off the day
  // cards, grouped per leg. Skipped entirely if every leg's dining content
  // was anchor-only (nothing secondary/casual was ever generated).
  if (data.diningRecommendations && data.diningRecommendations.length > 0) {
    children.push(spacer(200, 100))
    children.push(sectionTitle('DINING RECOMMENDATIONS'))
    data.diningRecommendations.forEach(block => {
      children.push(new Paragraph({
        spacing: { before: 200, after: 80 },
        children: [new TextRun({ text: block.legName.toUpperCase(), bold: true, size: 20, font: 'Arial', color: CHARCOAL, characterSpacing: 20 })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: RULE_GREY, space: 4 } },
      }))
      block.items.forEach(({ tier, text }) => {
        children.push(new Paragraph({
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({ text: tier === 'alt' ? '◦  ' : '·  ', bold: true, size: 20, font: 'Arial', color: tier === 'alt' ? MID_GREY : RULE_GREY }),
            new TextRun({ text, size: tier === 'alt' ? 19 : 17, font: 'Arial', color: MID_GREY, italics: tier === 'alt' }),
          ],
        }))
      })
    })
  }

  // Notes
  if (data.notes && data.notes.length > 0) {
    children.push(spacer(200, 100))
    children.push(sectionTitle('NOTES'))
    children.push(spacer(60, 40))
    data.notes.forEach(n => children.push(noteText(n)))
  }

  // Rate options
  if (hasLegs) {
    children.push(spacer(240, 100))
    children.push(sectionTitle('RATE OPTIONS'))
    data.legs.forEach(leg => {
      legRateOptions(leg).forEach(block => children.push(block))
    })

    if (data.flights && data.flights.length > 0) {
      children.push(new Paragraph({
        spacing: { before: 220, after: 60 },
        children: [new TextRun({ text: 'FLIGHTS', bold: true, size: 21, font: 'Arial', color: CHARCOAL })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: RULE_GREY, space: 4 } },
      }))
      data.flights.forEach((item, i) => {
        const label = data.flights.length > 1 ? `Option ${String.fromCharCode(65 + i)}` : 'Rate'
        children.push(lineItemCard(label, item.typeTagOverride ?? 'FLIGHT', item))
        children.push(spacer(60, 0))
      })
      if (data.flights.length > 1 && !data.flights.some(o => o.selected)) {
        children.push(noteText(`${data.flights.length} flight options presented — awaiting selection.`))
      }
    }

    children.push(spacer(240, 100))
    children.push(sectionTitle('TRIP INVESTMENT SUMMARY'))
    children.push(spacer(80, 60))
    children.push(investmentTable(data.legs, data.flights))
    children.push(spacer(80, 40))
    children.push(noteText('Rates shown are per the supplier confirmation on file and are subject to availability at the time of booking.'))
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            spacing: { after: 80 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: CHARCOAL, space: 4 } },
            children: [
              new TextRun({ text: 'PURELUXE', bold: true, size: 26, font: 'Arial', color: CHARCOAL }),
              new TextRun({ text: '   |   TRAVEL PROPOSAL', size: 20, font: 'Arial', color: MID_GREY }),
              new TextRun({ text: '   |   CONFIDENTIAL', size: 18, font: 'Arial', color: MID_GREY, italics: true }),
            ],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            spacing: { before: 80 },
            border: { top: { style: BorderStyle.SINGLE, size: 2, color: RULE_GREY, space: 4 } },
            children: [
              new TextRun({ text: 'PureLuxe International Limited  |  Rates as confirmed by supplier  |  Subject to availability', size: 17, font: 'Arial', color: MID_GREY }),
            ],
          })],
        }),
      },
      children,
    }],
  })

  return Packer.toBuffer(doc)
}
