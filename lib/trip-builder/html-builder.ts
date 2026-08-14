// HTML rendering of the same TripDocumentData that docx-builder.ts turns
// into a .docx — same sections, same B&W-with-brass-accent palette. This is
// the shared source for both the sidebar preview (served directly) and the
// PDF export (printed from this HTML via headless Chromium in
// pdf-renderer.ts). Word stays docx-builder's independent output; this
// never generates a .docx itself.

import fs from 'fs'
import path from 'path'
import type { TripDocumentData, LineItemSpec, LegRateOptions, DayEntry, LegDiningBlock, FlightSegment } from './docx-builder'

const CHARCOAL   = '#1A1A1A'
const DARK_GREY  = '#333333'
const MID_GREY   = '#666666'
const LIGHT_GREY = '#F2F2F2'
const RULE_GREY  = '#AAAAAA'
const DINING_BG  = '#E8E8E8'
const BRASS_BG   = '#F4EBDD'
const BRASS_TEXT = '#7A5726'

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function logoDataUri(): string | null {
  const logoPath = path.join(process.cwd(), 'lib', 'trip-builder', 'assets', 'pureluxe-logo.jpg')
  if (!fs.existsSync(logoPath)) return null
  return `data:image/jpeg;base64,${fs.readFileSync(logoPath).toString('base64')}`
}

// accommodationDisplay() (document-assembler.ts) encodes an undecided hotel
// as "TBC\n<option 1>\n<option 2>\n..." — one line per candidate property —
// rather than a vague "Hotel TBD (5 options)" that named none of them. Any
// other cell/value is always a single line and renders unchanged.
function hotelCellHtml(text: string): string {
  const lines = text.split('\n')
  if (lines.length === 1) return escapeHtml(text)
  const [label, ...options] = lines
  return `<div class="hotel-tbc">${escapeHtml(label)}</div>${options.map(o => `<div class="hotel-option">${escapeHtml(o)}</div>`).join('')}`
}

function glanceTableHtml(rows: [string, string, string, string][]): string {
  const headers = ['Dates', 'Destination', 'Hotel', 'Highlights']
  return `
  <table class="glance-table">
    <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.map((row, i) => `
        <tr class="${i % 2 === 0 ? 'shade' : ''}">
          ${row.map((cell, j) => `<td class="${j < 2 ? 'tcenter' : ''} ${j === 1 ? 'bold' : ''}">${j === 2 ? hotelCellHtml(cell) : escapeHtml(cell)}</td>`).join('')}
        </tr>`).join('')}
    </tbody>
  </table>`
}

function dayCardHtml(day: DayEntry): string {
  // Only HOTEL/DINING(anchor)/NOTE/plain confirmed items reach here — the
  // assembler routes secondary ("alt") and casual dining mentions into
  // diningRecommendations instead, rendered separately below.
  const rows = day.items.map((item, i) => {
    const isHotel  = item.startsWith('HOTEL:')
    const isDining = item.startsWith('DINING:')
    const isNote   = item.startsWith('NOTE:')
    const text     = item.replace(/^(HOTEL:|DINING:|NOTE:)\s*/, '')
    let prefix = '›', cls = 'confirmed'
    if (isHotel)  { prefix = '★'; cls = 'hotel' }
    if (isDining) { prefix = '♦'; cls = 'dining' }
    if (isNote)   { prefix = '✦'; cls = 'note' }
    const rowClass = isHotel ? 'hotel-row' : isDining ? 'dining-row' : (i % 2 === 0 ? 'shade' : '')
    return `
      <tr class="${rowClass}">
        <td class="day-prefix ${cls}">${prefix}</td>
        <td class="day-text ${cls}">${escapeHtml(text)}</td>
      </tr>`
  }).join('')

  return `
  <table class="day-card">
    <tr class="day-header">
      <td class="day-num">
        <div class="day-num-label">Day ${day.dayNum}</div>
        <div class="day-date">${escapeHtml(day.date)}</div>
      </td>
      <td class="day-title-cell">
        <div><span class="day-location">${escapeHtml(day.location.toUpperCase())}</span><span class="day-sep">·</span><span class="day-title">${escapeHtml(day.title)}</span></div>
        ${day.hotel ? `<div class="day-hotel">${hotelCellHtml(day.hotel)}</div>` : ''}
      </td>
    </tr>
    ${rows}
  </table>`
}

function diningRecommendationsHtml(blocks: LegDiningBlock[]): string {
  return blocks.map(block => `
    <h3 class="leg-title">${escapeHtml(block.legName.toUpperCase())}</h3>
    ${block.items.map(({ tier, text }) => `
      <p class="dining-rec ${tier}"><span class="dining-rec-symbol ${tier}">${tier === 'alt' ? '◦' : '·'}</span>${escapeHtml(text)}</p>
    `).join('')}
  `).join('')
}

function segmentsTableHtml(segments: FlightSegment[]): string {
  const headers = ['Flight', 'Route', 'Date', 'Time', 'Duration', 'Stops', 'Aircraft']
  const rows = segments.map((seg, i) => {
    const cells = [
      seg.flightNumber ?? '—',
      seg.route,
      seg.date ?? '—',
      seg.departure || seg.arrival ? `${seg.departure ?? '?'}–${seg.arrival ?? '?'}` : '—',
      seg.duration ?? '—',
      seg.stops ?? '—',
      seg.aircraft ?? '—',
    ]
    const rowClass = i % 2 === 0 ? '' : 'shade'
    let html = `<tr class="${rowClass}">${cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`
    if (seg.notes) html += `<tr class="${rowClass}"><td colspan="7" class="seg-note">${escapeHtml(seg.notes)}</td></tr>`
    return html
  }).join('')

  return `
  <table class="segments-table">
    <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

function lineItemCardHtml(label: string, typeTag: string, item: LineItemSpec): string {
  let bodyRows = ''
  if (item.pending) {
    bodyRows += `<tr class="shade"><td class="info-label">Rate</td><td class="info-value">Pending — awaiting supplier confirmation</td></tr>`
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

    bodyRows += `<tr class="shade"><td class="info-label">Rate</td><td class="info-value">${escapeHtml(rateLine)}</td></tr>`
    if (item.segments?.length) {
      bodyRows += `<tr><td colspan="2" class="segments-cell">${segmentsTableHtml(item.segments)}</td></tr>`
      if (item.details) bodyRows += `<tr><td class="info-label">Other details</td><td class="info-value">${escapeHtml(item.details)}</td></tr>`
    } else if (item.details) {
      bodyRows += `<tr><td class="info-label">Details</td><td class="info-value">${escapeHtml(item.details)}</td></tr>`
    }
    if (item.inclusions?.length) bodyRows += `<tr class="shade"><td class="info-label">Inclusions</td><td class="info-value">${escapeHtml(item.inclusions.join('   ·   '))}</td></tr>`
    if (item.cancellation) bodyRows += `<tr><td class="info-label">Cancellation policy</td><td class="info-value">${escapeHtml(item.cancellation)}</td></tr>`
    if (hasMultipleUnits) {
      bodyRows += `<tr class="shade"><td class="info-label">Subtotal per room${taxSuffix}</td><td class="info-value">${currency} ${itemSubtotalPerUnit(item).toLocaleString()}</td></tr>`
      bodyRows += `<tr class="shade"><td class="info-label">Subtotal — ${item.unitCount} rooms${taxSuffix}</td><td class="info-value brass bold">${currency} ${itemSubtotal(item).toLocaleString()}</td></tr>`
    } else {
      bodyRows += `<tr class="shade"><td class="info-label">Subtotal${taxSuffix}</td><td class="info-value brass bold">${currency} ${itemSubtotal(item).toLocaleString()}</td></tr>`
    }
  }

  return `
  <table class="line-item-card">
    <tr>
      <td colspan="2" class="line-item-header">
        <div><span class="tag">${escapeHtml(typeTag)} · ${escapeHtml(label)} · </span><span class="item-title">${escapeHtml(item.title)}</span></div>
        ${item.subtitle ? `<div class="item-subtitle">${escapeHtml(item.subtitle)}</div>` : ''}
      </td>
    </tr>
    ${bodyRows}
  </table>`
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
// stays exactly as quoted (see LineItemSpec import) — this is the only
// place tax and unitCount actually apply to the total.
function itemSubtotal(item: LineItemSpec): number {
  return itemSubtotalPerUnit(item) * (item.unitCount || 1)
}

function categoryBlockHtml(categoryLabel: string, typeTag: string, items: LineItemSpec[]): string {
  let html = `<p class="category-label">${escapeHtml(categoryLabel)}</p>`
  items.forEach((item, i) => {
    const label = items.length > 1 ? `Option ${String.fromCharCode(65 + i)}` : 'Rate'
    html += lineItemCardHtml(label, typeTag, item)
  })
  if (items.length > 1 && !items.some(o => o.selected)) {
    html += `<p class="note-text">${items.length} options presented for ${escapeHtml(categoryLabel.toLowerCase())} — awaiting selection.</p>`
  }
  return html
}

function legRateOptionsHtml(leg: LegRateOptions): string {
  const dateSuffix = leg.dateRange ? `<span class="leg-dates">   ·   ${escapeHtml(leg.dateRange)}</span>` : ''
  let html = `<h3 class="leg-title">${escapeHtml(leg.name.toUpperCase())}${dateSuffix}</h3>`
  const cats = leg.categories || {}
  if (cats.accommodation?.length) html += categoryBlockHtml('Accommodation', 'STAY', cats.accommodation)
  if (cats.activities?.length)    html += categoryBlockHtml('Activities', 'ACTIVITY', cats.activities)
  if (cats.transfers?.length)     html += categoryBlockHtml('Transfers', 'TRANSFER', cats.transfers)
  return html
}

// Per-currency totals — mirrors docx-builder's investmentTable exactly,
// including the currency-mislabeling fix (never a hardcoded "USD").
function investmentTableHtml(legs: LegRateOptions[], flights: LineItemSpec[]): string {
  const grandTotalByCurrency: Record<string, number> = {}
  let anyExcluded = false
  const bodyRows: string[] = []

  const evalItems = (rowLabel: string, items: LineItemSpec[] | undefined) => {
    if (!items || items.length === 0) return
    const confirmed = items.filter(o => !o.pending)
    if (confirmed.length === 0) {
      anyExcluded = true
      bodyRows.push(`<tr><td class="bold">${escapeHtml(rowLabel)}</td><td class="tcenter">Pending</td><td class="tcenter">—</td></tr>`)
    } else if (confirmed.length > 1 && !confirmed.some(o => o.selected)) {
      anyExcluded = true
      bodyRows.push(`<tr><td class="bold">${escapeHtml(rowLabel)}</td><td class="tcenter">${confirmed.length} options</td><td class="tcenter italic mid">Awaiting selection</td></tr>`)
    } else {
      const chosen = confirmed.length === 1 ? confirmed[0] : confirmed.find(o => o.selected)!
      const subtotal = itemSubtotal(chosen)
      const currency = chosen.currency || 'USD'
      grandTotalByCurrency[currency] = (grandTotalByCurrency[currency] ?? 0) + subtotal
      bodyRows.push(`<tr><td class="bold">${escapeHtml(rowLabel)}</td><td class="tcenter">${escapeHtml(chosen.title)}</td><td class="tcenter">${currency} ${subtotal.toLocaleString()}</td></tr>`)
    }
  }

  legs.forEach(leg => {
    const cats = leg.categories || {}
    if (cats.accommodation?.length) evalItems(`${leg.name} — accommodation`, cats.accommodation)
    if (cats.activities?.length)    evalItems(`${leg.name} — activities`, cats.activities)
    if (cats.transfers?.length)     evalItems(`${leg.name} — transfers`, cats.transfers)
  })
  if (flights?.length) evalItems('Flights', flights)

  const currencies = Object.keys(grandTotalByCurrency).sort()
  const totalRows = currencies.length
    ? currencies.map((currency, i) => {
        const isLast = i === currencies.length - 1
        const label = isLast ? (anyExcluded ? 'Total so far (excludes pending / unselected items)' : 'Total trip investment') : ''
        return `<tr class="total-row"><td colspan="2" class="total-label">${escapeHtml(label)}</td><td class="total-value">${currency} ${grandTotalByCurrency[currency].toLocaleString()}</td></tr>`
      }).join('')
    : `<tr class="total-row"><td colspan="2" class="total-label">Total trip investment</td><td class="total-value">—</td></tr>`

  return `
  <table class="investment-table">
    <thead><tr><th class="tleft">Item</th><th>Status</th><th>Subtotal</th></tr></thead>
    <tbody>${bodyRows.join('')}${totalRows}</tbody>
  </table>`
}

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: ${DARK_GREY}; margin: 0; padding: 0 36px 36px; font-size: 11pt; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid ${RULE_GREY}; padding: 6px 10px; }
  .doc-header { font-size: 10pt; color: ${MID_GREY}; border-bottom: 2px solid ${CHARCOAL}; padding: 10px 36px; margin-bottom: 4px; }
  .doc-header b { color: ${CHARCOAL}; }
  .doc-footer { font-size: 8.5pt; color: ${MID_GREY}; border-top: 1px solid ${RULE_GREY}; padding: 8px 36px; margin-top: 24px; }
  .title-block { padding-top: 16px; }
  .logo { height: 42px; margin-bottom: 10px; display: block; }
  .title { font-size: 30pt; color: ${CHARCOAL}; margin: 0 0 6px; }
  .subtitle { font-size: 13pt; color: ${MID_GREY}; margin: 0 0 6px; }
  .meta { font-size: 10.5pt; color: ${MID_GREY}; margin: 0 0 4px; border-bottom: 3px solid ${CHARCOAL}; padding-bottom: 10px; }
  .legend { margin: 14px 0 20px; }
  .legend p { margin: 3px 0; font-size: 9.5pt; }
  .legend-symbol { font-weight: bold; color: ${CHARCOAL}; margin-right: 6px; }
  .legend-symbol.mid { color: ${MID_GREY}; }
  .legend-symbol.dark { color: ${DARK_GREY}; }
  .section-title { font-size: 13pt; color: ${CHARCOAL}; border-bottom: 3px solid ${CHARCOAL}; padding-bottom: 6px; margin: 28px 0 14px; }
  .glance-table th { background: ${CHARCOAL}; color: #fff; font-size: 10pt; text-align: center; }
  .glance-table td { font-size: 9.5pt; }
  .shade { background: ${LIGHT_GREY}; }
  .tcenter { text-align: center; }
  .tleft { text-align: left; }
  .bold { font-weight: bold; }
  .italic { font-style: italic; }
  .mid { color: ${MID_GREY}; }
  .brass { color: #A9793F; }
  .day-card { margin-bottom: 16px; }
  .day-header td { background: ${CHARCOAL}; color: #fff; border-color: ${CHARCOAL}; vertical-align: middle; }
  .day-num { width: 90px; }
  .day-num-label { font-weight: bold; font-size: 11pt; }
  .day-date { font-size: 8.5pt; color: #BBBBBB; }
  .day-location { font-weight: bold; font-size: 9pt; color: #AAAAAA; letter-spacing: 0.5px; }
  .day-sep { color: #666; margin: 0 6px; }
  .day-title { font-weight: bold; font-size: 11pt; }
  .day-hotel { font-size: 8.5pt; color: #AAAAAA; font-style: italic; margin-top: 2px; }
  .day-hotel .hotel-tbc { font-weight: bold; font-style: normal; color: ${BRASS_TEXT}; }
  .day-hotel .hotel-option { font-style: normal; }
  .hotel-tbc { font-weight: bold; color: ${BRASS_TEXT}; }
  .hotel-option { font-size: 8.5pt; color: ${MID_GREY}; margin-top: 1px; }
  .day-prefix { width: 40px; text-align: center; font-size: 11pt; }
  .day-text { font-size: 9.5pt; }
  .dining-row { background: ${DINING_BG}; }
  .hotel-row { background: ${BRASS_BG}; }
  .day-text.hotel, .day-prefix.hotel { font-weight: bold; color: #1A1A1A; }
  .day-prefix.hotel { color: #A9793F; }
  .day-text.dining, .day-prefix.dining { font-weight: bold; color: #1A1A1A; }
  .day-text.note, .day-prefix.note { color: ${MID_GREY}; font-style: italic; }
  .note-text { font-size: 9pt; color: ${MID_GREY}; font-style: italic; margin: 6px 0; }
  .dining-rec { margin: 4px 0; font-size: 9.5pt; color: ${MID_GREY}; }
  .dining-rec.alt { font-style: italic; }
  .dining-rec.casual { font-size: 8.5pt; }
  .dining-rec-symbol { font-weight: bold; margin-right: 6px; }
  .dining-rec-symbol.alt { color: ${MID_GREY}; }
  .dining-rec-symbol.casual { color: ${RULE_GREY}; }
  .leg-title { font-size: 10.5pt; color: ${CHARCOAL}; border-bottom: 1px solid ${RULE_GREY}; padding-bottom: 4px; margin: 20px 0 8px; }
  .leg-dates { font-size: 9pt; font-weight: normal; color: ${MID_GREY}; }
  .category-label { font-size: 9.5pt; color: ${MID_GREY}; font-weight: bold; margin: 12px 0 6px; }
  .line-item-card { margin-bottom: 8px; }
  .line-item-header { background: ${CHARCOAL}; color: #fff; }
  .line-item-header .tag { font-size: 8.5pt; color: #D9BE8F; font-weight: bold; }
  .line-item-header .item-title { font-size: 11pt; font-weight: bold; }
  .item-subtitle { font-size: 9pt; color: #BBBBBB; font-style: italic; margin-top: 2px; }
  .info-label { width: 26%; font-size: 9pt; color: ${MID_GREY}; }
  .info-value { font-size: 9.5pt; }
  .segments-cell { padding: 0; }
  .segments-table { margin: 2px 0; }
  .segments-table th { background: #ECECEC; color: ${MID_GREY}; font-size: 8pt; text-align: left; padding: 4px 8px; }
  .segments-table td { font-size: 8.5pt; padding: 4px 8px; }
  .seg-note { font-size: 8pt; font-style: italic; color: ${MID_GREY}; }
  .investment-table th { background: ${CHARCOAL}; color: #fff; font-size: 10pt; }
  .investment-table th:not(:first-child), .investment-table td:not(:first-child) { text-align: center; }
  .total-row td { background: ${BRASS_BG}; color: ${BRASS_TEXT}; font-weight: bold; }
  .total-label { text-align: right; font-size: 10pt; }
  .total-value { font-size: 11pt; }
`

export function buildTripDocumentHtml(data: TripDocumentData): string {
  const logo = logoDataUri()
  const hasDays = data.days.length > 0
  const hasGlance = data.glance.length > 0
  // See docx-builder.ts's identical comment: a trip whose rate items are
  // all leg-less still has real content in `flights` — gating on legs
  // alone would silently drop the whole Rate Options section.
  const hasLegs = data.legs.length > 0 || data.flights.length > 0

  let body = `<div class="title-block">`
  if (logo) body += `<img class="logo" src="${logo}" alt="PureLuxe" />`
  body += `<h1 class="title">${escapeHtml(data.title)}</h1>`
  body += `<p class="subtitle">Luxury Journey&nbsp;&nbsp;|&nbsp;&nbsp;${escapeHtml(data.subtitle)}</p>`
  body += `<p class="meta">${escapeHtml(data.dates)}&nbsp;&nbsp;|&nbsp;&nbsp;${escapeHtml(data.guests)}&nbsp;&nbsp;|&nbsp;&nbsp;Proposed Itinerary for Discussion</p>`
  body += `</div>`

  if (hasDays) {
    body += `<div class="legend">
      <p><span class="legend-symbol">›</span>Confirmed / included service</p>
      <p><span class="legend-symbol brass">★</span>Hotel highlight</p>
      <p><span class="legend-symbol">♦</span>Anchor dining recommendation</p>
      <p><span class="legend-symbol dark">✦</span>Important note</p>
    </div>`
  }

  if (hasGlance) {
    body += `<h2 class="section-title">JOURNEY AT A GLANCE</h2>${glanceTableHtml(data.glance)}`
  }

  if (hasDays) {
    body += `<h2 class="section-title">DAY BY DAY ITINERARY</h2>${data.days.map(dayCardHtml).join('')}`
  }

  if (data.diningRecommendations.length) {
    body += `<h2 class="section-title">DINING RECOMMENDATIONS</h2>${diningRecommendationsHtml(data.diningRecommendations)}`
  }

  if (data.notes.length) {
    body += `<h2 class="section-title">NOTES</h2>${data.notes.map(n => `<p class="note-text">• ${escapeHtml(n)}</p>`).join('')}`
  }

  if (hasLegs) {
    body += `<h2 class="section-title">RATE OPTIONS</h2>${data.legs.map(legRateOptionsHtml).join('')}`

    if (data.flights.length) {
      body += `<h3 class="leg-title">FLIGHTS</h3>`
      data.flights.forEach((item, i) => {
        const label = data.flights.length > 1 ? `Option ${String.fromCharCode(65 + i)}` : 'Rate'
        body += lineItemCardHtml(label, item.typeTagOverride ?? 'FLIGHT', item)
      })
      if (data.flights.length > 1 && !data.flights.some(o => o.selected)) {
        body += `<p class="note-text">${data.flights.length} flight options presented — awaiting selection.</p>`
      }
    }

    body += `<h2 class="section-title">TRIP INVESTMENT SUMMARY</h2>${investmentTableHtml(data.legs, data.flights)}`
    body += `<p class="note-text">• Rates shown are per the supplier confirmation on file and are subject to availability at the time of booking.</p>`
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(data.title)}</title>
<style>${CSS}</style>
</head>
<body>
  <div class="doc-header"><b>PURELUXE</b> | TRAVEL PROPOSAL | <span class="italic">CONFIDENTIAL</span></div>
  ${body}
  <div class="doc-footer">PureLuxe International Limited | Rates as confirmed by supplier | Subject to availability</div>
</body>
</html>`
}
