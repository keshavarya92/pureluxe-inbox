// Hotel availability + rates + price check against Sabre GDS. Ported
// from pureluxe-rates's src/sabre/hotelSearch.js — same three-phase
// shape (avail -> rates -> price check), same NC-rate exclusion and
// dual rate-plan-group calls (consortium/priority chains in one call,
// remaining chains + BAR fallback in a parallel second call, merged by
// rate key with lower price winning on conflict).
//
// gdsAdapter (rate-sources.ts) calls searchHotels + getHotelRates.
// verifyRate (Sabre's price-check phase) isn't wired into anything yet
// — resolveRateSelection's own docstring lists a pre-quote confirmation
// step as out of scope for now — but is exported here since it's part
// of the same three-phase contract the original module made, ready for
// whenever that step gets built.

import { authorizedRequest } from './auth'
import { withRetry } from './retry'
import { getPCC, CORP_DISCOUNT, getRatePlanGroup1, getRatePlanGroup2 } from './access-codes'

function endpoint(): string {
  const url = process.env.SABRE_ENDPOINT
  if (!url) throw new Error('Sabre is not configured — set SABRE_ENDPOINT in .env.local')
  return url
}

function hotelHeaders(): Record<string, string> {
  const appId = process.env.SABRE_APP_ID
  if (!appId) throw new Error('Sabre is not configured — set SABRE_APP_ID in .env.local')
  return {
    'Content-Type':    'application/json',
    Accept:            'application/json',
    'Conversation-ID': `plx-${Date.now()}`,
    'Application-ID':  appId,
  }
}

// Business rule: NC (non-commissionable) rates never shown.
const NC_RATE_FILTER = {
  RateFilters: { RateFilter: [{ Type: 'Commission', Value: 'NC', Action: 'Exclude' }] },
}

// Sabre's Rooms.Room is an array — one entry per physical room, each with
// its own occupancy, not a single entry carrying the trip's total pax.
// Adults are split as evenly as possible across rooms (remainder to the
// first rooms); all children ride in room 1, since TripContext has no
// per-room breakdown to split them by.
function buildRooms(adults: number, children: number, rooms: number) {
  const roomCount = Math.max(1, rooms)
  const base       = Math.floor(adults / roomCount)
  const remainder  = adults % roomCount

  return Array.from({ length: roomCount }, (_, i) => {
    const room: Record<string, unknown> = { Index: i + 1, Adults: base + (i < remainder ? 1 : 0) }
    if (i === 0 && children > 0) room.Children = children
    return room
  })
}

// ─── Phase 1: property list ───────────────────────────────────────────

export interface HotelSearchParams {
  destination: string // IATA city code, e.g. 'LHR', 'PAR', 'DXB'
  checkIn:     string // 'YYYY-MM-DD'
  checkOut:    string
  adults?:     number
  children?:   number
  rooms?:      number
  currency?:   string
}

export interface SabreAvailProperty {
  hotelCode: string | undefined
  hotelName: string | undefined
  chainCode: string | undefined
  chainName: string | undefined
  rating:    number | undefined
  leadRate:  number | undefined
  currency:  string | undefined
}

export interface HotelAvailResult {
  notInSabre: boolean
  properties: SabreAvailProperty[]
}

export async function searchHotels({
  destination, checkIn, checkOut, adults = 1, children = 0, rooms = 1, currency = 'USD',
}: HotelSearchParams): Promise<HotelAvailResult> {
  const res = await withRetry(
    () => authorizedRequest<any>(`${endpoint()}/v5/get/hotelavail`, {
      method:  'POST',
      headers: hotelHeaders(),
      body: JSON.stringify({
        GetHotelAvailRQ: {
          POS: { Source: { PseudoCityCode: getPCC() } },
          SearchCriteria: {
            OffSet: 1, SortBy: 'NegotiatedRateAvailability', SortOrder: 'ASC', PageSize: 100,
            GeoSearch: {
              GeoRef: { Radius: 30, UOM: 'MI', RefPoint: { Value: destination, ValueContext: 'CODE', RefPointType: '6' } },
            },
            RateInfoRef: {
              CurrencyCode: currency, BestOnly: '4', PrepaidQualifier: 'IncludePrepaid', ConvertedRateInfoOnly: true,
              StayDateTimeRange: { StartDate: checkIn, EndDate: checkOut },
              Rooms: { Room: buildRooms(adults, children, rooms) },
              RateSource: '100,113',
              ...(CORP_DISCOUNT && { CorpDiscount: CORP_DISCOUNT }),
            },
          },
        },
      }),
    }),
    'phase1.hotelavail'
  )

  return parseAvailResponse(res)
}

function parseAvailResponse(data: any): HotelAvailResult {
  const rs = data?.GetHotelAvailRS
  if (!rs || rs.ApplicationResults?.status === 'NotProcessed') return { properties: [], notInSabre: true }

  const hotels = [].concat(rs.HotelAvailInfos?.HotelAvailInfo ?? [])
  if (hotels.length === 0) return { properties: [], notInSabre: true }

  return {
    notInSabre: false,
    properties: hotels.map((h: any) => ({
      hotelCode: h.BasicPropertyInfo?.HotelCode,
      hotelName: h.BasicPropertyInfo?.HotelName,
      chainCode: h.BasicPropertyInfo?.ChainCode,
      chainName: h.BasicPropertyInfo?.ChainName,
      rating:    h.BasicPropertyInfo?.SabreRating,
      leadRate:  h.RateInfos?.RateInfo?.[0]?.ConvertedRateInfo?.AmountBeforeTax,
      currency:  h.RateInfos?.RateInfo?.[0]?.ConvertedRateInfo?.CurrencyCode,
    })),
  }
}

// ─── Phase 2: room types and rates (dual parallel calls) ──────────────

export interface HotelRatesParams {
  hotelCode: string
  checkIn:   string
  checkOut:  string
  adults?:   number
  children?: number
  rooms?:    number
  currency?: string
}

export interface SabreRate {
  rateKey:            string
  ratePlanCode:        string | undefined
  roomDescription:     string | undefined
  boardBasis:          string | undefined
  amountBeforeTax:     number
  amountAfterTax:      number
  averageNightlyRate:  number
  currency:            string | undefined
  cancellation:        any
  consortiumBenefits:  any
  minimumStayNights:   number | null
  isNegotiated:        boolean
  isRefundable:        boolean
}

export interface HotelRatesResult {
  hotelCode:           string
  propertyInfo:        any
  rates:               SabreRate[]
  partial:             boolean
  minimumStayFlag:     boolean
  childRateAvailable:  boolean | null
}

export async function getHotelRates({
  hotelCode, checkIn, checkOut, adults = 1, children = 0, rooms = 1, currency = 'USD',
}: HotelRatesParams): Promise<HotelRatesResult> {
  const roomEntries = buildRooms(adults, children, rooms)

  const buildPayload = (ratePlanCandidates: unknown[]) => ({
    GetHotelDetailsRQ: {
      POS: { Source: { PseudoCityCode: getPCC() } },
      SearchCriteria: {
        HotelRefs: { HotelRef: { HotelCode: hotelCode, CodeContext: 'GLOBAL' } },
        RateInfoRef: {
          CurrencyCode: currency, PrepaidQualifier: 'IncludePrepaid', ConvertedRateInfoOnly: true,
          StayDateTimeRange: { StartDate: checkIn, EndDate: checkOut },
          Rooms: { Room: roomEntries },
          RatePlanCandidates: { ExactMatchOnly: false, RatePlanCandidate: ratePlanCandidates },
          ...NC_RATE_FILTER,
          RateSource: '100,113', SortBy: 'NegotiatedRates', SortOrder: 'ASC',
          ...(CORP_DISCOUNT && { CorpDiscount: CORP_DISCOUNT }),
        },
        HotelContentRef: {
          DescriptiveInfoRef: {
            PropertyInfo: true, LocationInfo: true, Amenities: true,
            Descriptions: { Description: [{ Type: 'ShortDescription' }, { Type: 'CancellationPolicy' }, { Type: 'DepositPolicy' }] },
          },
        },
      },
    },
  })

  const [settled1, settled2] = await Promise.allSettled([
    withRetry(
      () => authorizedRequest<any>(`${endpoint()}/v5/get/hoteldetails`, {
        method: 'POST', headers: hotelHeaders(), body: JSON.stringify(buildPayload(getRatePlanGroup1())),
      }),
      'phase2.group1'
    ),
    withRetry(
      () => authorizedRequest<any>(`${endpoint()}/v5/get/hoteldetails`, {
        method: 'POST', headers: hotelHeaders(), body: JSON.stringify(buildPayload(getRatePlanGroup2())),
      }),
      'phase2.group2'
    ),
  ])

  return mergeRates(settled1, settled2, hotelCode, children > 0)
}

function mergeRates(
  settled1: PromiseSettledResult<any>,
  settled2: PromiseSettledResult<any>,
  hotelCode: string,
  childrenRequested: boolean,
): HotelRatesResult {
  const rateMap = new Map<string, SabreRate>() // RateKey -> rate, lower price wins on conflict
  let propertyInfo: any = null
  let partial      = false
  let minimumStay  = false

  for (const settled of [settled1, settled2]) {
    if (settled.status === 'rejected') { partial = true; continue }

    const info = settled.value?.GetHotelDetailsRS?.HotelDetailsInfo
    if (!info) { partial = true; continue }

    if (!propertyInfo && info.HotelInfo) propertyInfo = info.HotelInfo

    for (const rate of [].concat(info.RateInfos?.RateInfo ?? [])) {
      const key = (rate as any).RateKey
      if (!key) continue

      const conv   = (rate as any).ConvertedRateInfo
      const raw    = (rate as any).RateInfo
      const amount = Number(conv?.AmountBeforeTax ?? raw?.AmountBeforeTax ?? 0)

      if (rateMap.has(key) && rateMap.get(key)!.amountBeforeTax <= amount) continue

      rateMap.set(key, {
        rateKey:            key,
        ratePlanCode:       (rate as any).RatePlanCode,
        roomDescription:    (rate as any).RoomDescription?.Text,
        boardBasis:         (rate as any).MealPlans?.MealPlan?.[0]?.MealPlanDescription,
        amountBeforeTax:    amount,
        amountAfterTax:     Number(conv?.AmountAfterTax ?? raw?.AmountAfterTax ?? 0),
        averageNightlyRate: Number(conv?.AverageNightlyRate ?? 0),
        currency:           conv?.CurrencyCode ?? raw?.CurrencyCode,
        cancellation:       (rate as any).CancelPenalties?.CancelPenalty ?? null,
        consortiumBenefits: (rate as any).SpecialOffers?.SpecialOffer ?? null,
        minimumStayNights:  raw?.MinimumStay?.MinimumStayNights ?? null,
        isNegotiated:       ['10', '11', '22'].includes(String((rate as any).RatePlanType)),
        isRefundable:       !(rate as any).CancelPenalties?.CancelPenalty?.length,
      })

      if (raw?.MinimumStay?.MinimumStayNights) minimumStay = true
    }
  }

  return {
    hotelCode,
    propertyInfo,
    rates: [...rateMap.values()],
    partial,
    minimumStayFlag: minimumStay,
    // null = children not in search, true = children searched with rates
    // returned, false = children searched but nothing returned (flag for
    // manual entry).
    childRateAvailable: childrenRequested ? rateMap.size > 0 : null,
  }
}

// ─── Phase 3: price verification ───────────────────────────────────────

export interface PriceCheckResult {
  bookingKey:      string | null
  rateKey:         string
  priceMatch:      boolean
  originalAmount:  number | null
  confirmedAmount: number | null
  currency:        string | null
  available:       boolean
}

export async function verifyRate({ rateKey }: { rateKey: string }): Promise<PriceCheckResult> {
  const res = await withRetry(
    () => authorizedRequest<any>(`${endpoint()}/v5/hotel/pricecheck`, {
      method:  'POST',
      headers: hotelHeaders(),
      body: JSON.stringify({
        HotelPriceCheckRQ: { POS: { Source: { PseudoCityCode: getPCC() } }, RateInfoRef: { RateKey: rateKey } },
      }),
    }),
    'phase3.pricecheck'
  )

  return parsePriceCheck(res, rateKey)
}

function parsePriceCheck(data: any, rateKey: string): PriceCheckResult {
  const pc = data?.HotelPriceCheckRS?.PriceCheckInfo
  if (!pc) throw new Error('Price check returned no PriceCheckInfo — rate may be unavailable')

  const bookingKey      = pc.BookingKey ?? null
  const originalAmount  = pc.PriceComparison?.OriginalPrice ?? null
  const confirmedAmount = pc.PriceComparison?.NewPrice ?? null
  const priceMatch      = originalAmount !== null && originalAmount === confirmedAmount

  return {
    bookingKey, rateKey, priceMatch, originalAmount, confirmedAmount,
    currency:  pc.HotelRateInfo?.CurrencyCode ?? null,
    available: !!bookingKey,
  }
}
