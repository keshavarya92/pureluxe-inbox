// Pure fixture test for lib/trip-builder/hotelbeds/hotel-search.ts's
// parseHotelBlock/parseRate. No network, no credentials — always runs.
// Exists specifically to cover fields (rateType, rateCommentsId,
// rateComments, promotions, categoryCode/categoryName) that a live smoke
// test can't reliably exercise: neither known-good sandbox hotel (3424,
// 1070) has ever returned a RECHECK rate or every field in one response.
//
// Run: npx tsx scripts/test-hotelbeds-parse.ts

import { parseHotelBlock } from '../lib/trip-builder/hotelbeds/hotel-search'

let pass = 0
let fail = 0
function check(label: string, cond: boolean, detail?: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `\n  ${detail}` : ''}`)
  if (cond) pass++; else fail++
}

// Shaped after real sandbox responses (hotel 3424/1070) plus fields
// confirmed live during CheckRate probing (2026-08-12) that neither known
// hotel has organically returned yet: rateType 'RECHECK', promotions,
// rateCommentsId, categoryCode/categoryName.
const fixtureHotel = {
  code: 9999,
  name: 'Fixture Grand Hotel',
  currency: 'EUR',
  categoryCode: '5EST',
  categoryName: '5 STARS',
  rooms: [
    {
      code: 'DBL.ST',
      name: 'Double Standard',
      rates: [
        {
          rateKey: 'FIXTURE-RATEKEY-1',
          rateClass: 'NRF',
          rateType: 'RECHECK',
          net: '199.50',
          boardCode: 'BB',
          boardName: 'BED AND BREAKFAST',
          cancellationPolicies: [{ amount: '199.50', from: '2026-09-01T23:59:00+01:00' }],
          rateCommentsId: '59|12345|0',
          promotions: [
            { code: '073', name: 'Non-refundable rate. No amendments permitted', remark: 'Non-refundable rate. No amendments permitted' },
          ],
        },
        {
          rateKey: 'FIXTURE-RATEKEY-2',
          rateClass: 'NOR',
          rateType: 'BOOKABLE',
          net: '215.00',
          boardCode: 'HB',
          boardName: 'HALF BOARD',
          cancellationPolicies: [],
          taxes: { allIncluded: false, taxes: [{ included: false, amount: '5.00', currency: 'EUR', type: 'TAX', subType: 'City Tax' }] },
          // No rateCommentsId/promotions on this one — mirrors real
          // responses where they're only sometimes present.
        },
      ],
    },
  ],
}

const parsed = parseHotelBlock(fixtureHotel)

check('hotel-level: hotelName', parsed.hotelName === 'Fixture Grand Hotel')
check('hotel-level: currency', parsed.currency === 'EUR')
check('hotel-level: categoryCode', parsed.categoryCode === '5EST')
check('hotel-level: categoryName', parsed.categoryName === '5 STARS')
check('rate count', parsed.rates.length === 2, `got ${parsed.rates.length}`)

const [rechecked, bookable] = parsed.rates

check('rate 1: rateType RECHECK captured', rechecked.rateType === 'RECHECK')
check('rate 1: rateCommentsId captured', rechecked.rateCommentsId === '59|12345|0')
check('rate 1: promotions captured', rechecked.promotions.length === 1 && rechecked.promotions[0].code === '073',
  JSON.stringify(rechecked.promotions))
check('rate 1: rateComments undefined when absent', rechecked.rateComments === undefined)
check('rate 1: net parsed as number', rechecked.net === 199.50)
check('rate 1: roomCode/roomName from parent room', rechecked.roomCode === 'DBL.ST' && rechecked.roomName === 'Double Standard')

check('rate 2: rateType BOOKABLE captured', bookable.rateType === 'BOOKABLE')
check('rate 2: promotions defaults to empty array when absent', Array.isArray(bookable.promotions) && bookable.promotions.length === 0)
check('rate 2: rateCommentsId undefined when absent', bookable.rateCommentsId === undefined)
check('rate 2: taxesAllIncluded false when taxes present and not included', bookable.taxesAllIncluded === false)
check('rate 2: net parsed as number', bookable.net === 215.00)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
