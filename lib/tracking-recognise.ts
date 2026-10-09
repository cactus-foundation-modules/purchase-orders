import { isFreeMailDomain } from './inbound-filing'

// Delivery tracking, read out of an email.
//
// PURE. Text in, what was found out: no database, no network, no clock (the
// caller says what day "today" is, in the site's own timezone). Everything
// lib/inbound-tracking.ts decides is decided on what this returns, so this is
// the file the tests pin.
//
// Generic by carrier, never by customer. Three kinds of email carry tracking
// to a purchasing mailbox:
//
//  - the supplier replying on the order's thread, sometimes with a link or a
//    number, sometimes with no more than "out for delivery today";
//  - a delivery firm writing on the supplier's behalf: a consignment number, the
//    supplier's own order number, the delivery address, and later a delivery
//    day and timeslot with a link to the firm's tracking page;
//  - a parcel carrier: a parcel number and a follow-my-parcel link.
//
// What is recognised:
//
//  - parcel carriers' deep links, named off a short table of their hosts, and
//    DPD's follow-my-parcel link with its code;
//  - Multidrop-style links, /<code>/<postcode>, used by several delivery firms;
//  - AIT Home Delivery's short link, aithd.com/<code> (or aithd.de), whose code
//    is the parcel and may be letters only;
//  - a number written beside a "Consignment", "Tracking number" or "Parcel"
//    label, spaces and all ("Your parcel: 1234 5678 901 234");
//  - any other link whose address mentions "track" AND carries something that
//    identifies a parcel (a generic "track your order" page does not);
//  - a delivery day (DD/MM/YYYY, read by hand - never `new Date`, which reads
//    08/09 as August in America), a timeslot, the supplier's own order number,
//    and delivery postcodes.
//
// What is ignored: tracking pixels, click-counting redirects, unsubscribe,
// feedback and review links, pictures, and everything below the first line of
// a quoted earlier email - a reply that quotes last week's tracking is not
// news about this week's parcel.
//
// The URL patterns are a small copy of what shop's lib/tracking/* knows,
// deliberately duplicated: this module cannot import shop, and the list is
// short.

/** One parcel, as far as one email describes it. */
export type TrackingCandidate = {
  /** Who is carrying it, where the email or the link says. Null for a delivery
   *  firm's own page - the module that announces it has the sender to go on. */
  carrier: string | null
  /** The parcel or consignment number, with its spaces taken out. */
  trackingNumber: string | null
  trackingUrl: string | null
  /** The code out of a follow-my-parcel link. Stored as the code, never the
   *  link: the address is the carrier's to restructure. */
  shortCode: string | null
}

export type RecognisedTracking = {
  /** Every parcel found, strongest first. Usually none or one. */
  candidates: TrackingCandidate[]
  /** 'YYYY-MM-DD', when the email names the delivery day. */
  deliveryDate: string | null
  /** ['HH:MM', 'HH:MM'], when it names a window. */
  deliverySlot: [string, string] | null
  /** Numbers written beside an order label ("Sales Order 0000123456", "Order
   *  number 123456"): the supplier's own reference, as printed. */
  supplierRefs: string[]
  /** Numbers beside the looser labels - "Your order", "Our ref", "Our order".
   *  From the supplier those are their reference; on a courier's email they
   *  are as likely the courier's own job number or the retailer's, so only a
   *  supplier's email is matched on them. */
  looseRefs: string[]
  /** Delivery postcodes, normalised ('AB1 2CD'): out of a Multidrop-style link,
   *  or out of the lines under an address label. */
  postcodes: string[]
  /** The second half of that: only the ones under an address label, for a
   *  caller that throws a link away and must not keep the postcode it gave. */
  addressPostcodes: string[]
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** A line that starts quoted history: Outlook's header block, Gmail's "On ...
 *  wrote:", a forwarded-message rule. Everything from it down is somebody's
 *  earlier email. */
const QUOTE_START = /^\s*(?:-{2,}\s*(?:original|forwarded) message|from:\s|sent:\s|on\s.{4,200}\swrote:\s*$|_{6,}\s*$)/i

/** The lines of the email's own text: tabs and runs of spaces folded, quoted
 *  history (">" lines and everything below a quote header) dropped. */
export function ownLines(bodyText: string): string[] {
  const out: string[] = []
  for (const raw of bodyText.replace(/\r\n?/g, '\n').split('\n')) {
    if (QUOTE_START.test(raw)) break
    if (/^\s*>/.test(raw)) continue
    const line = raw.replace(/[\t ]+/g, ' ').replace(/ {2,}/g, ' ').trim()
    if (line) out.push(line)
  }
  return out
}

/** The line and the one after it, for a label printed above its value
 *  ("DELIVERY DATE" on one line, "TUE 08/09/2026" on the next). */
function withNext(lines: readonly string[], index: number, rest: string): string {
  const next = lines[index + 1] ?? ''
  return rest.trim() ? `${rest} ${next}` : next
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s<>"'[\]()]+/gi

/** Carriers named off their own host. Carriers, not anybody's customers. */
const CARRIER_HOSTS: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)dpd(local)?\.co\.uk$/, 'DPD'],
  [/(^|\.)dpd\.(com|ie)$/, 'DPD'],
  [/(^|\.)royalmail\.com$/, 'Royal Mail'],
  [/(^|\.)parcelforce\.(com|net)$/, 'Parcelforce'],
  [/(^|\.)(evri\.com|hermes-europe\.co\.uk|myhermes\.co\.uk)$/, 'Evri'],
  [/(^|\.)ups\.com$/, 'UPS'],
  [/(^|\.)dhl\.(com|co\.uk|de)$/, 'DHL'],
  [/(^|\.)fedex\.com$/, 'FedEx'],
  [/(^|\.)tnt\.(com|co\.uk)$/, 'TNT'],
  [/(^|\.)yodel\.co\.uk$/, 'Yodel'],
  [/(^|\.)(dx\.co\.uk|thedx\.co\.uk)$/, 'DX'],
  [/(^|\.)apc-overnight\.com$/, 'APC'],
  [/(^|\.)tuffnells\.co\.uk$/, 'Tuffnells'],
  [/(^|\.)palletways\.com$/, 'Palletways'],
  [/(^|\.)gfsdeliver\.com$/, 'GFS'],
  [/(^|\.)(aithd\.(com|de)|aitworldwide\.com)$/, 'AIT'],
]

/** AIT Home Delivery's short link: 'https://aithd.com/kz0vkrz', or aithd.de for
 *  their German site. The code is the parcel - their own page asks their feed
 *  with it - and is often letters only, so it is read here by shape rather
 *  than left to the "names a parcel" test below, which wants a digit. The
 *  same pattern as shop's lib/tracking/ait-link.ts; their long
 *  '/<client>/<order>' address is not a key their feed takes, and is refused. */
const AIT_HOST = /^(?:www\.)?aithd\.(com|de)$/
const AIT_CODE = /^[A-Za-z0-9]{5,16}$/

/** Links that are never tracking whatever they say: pixels, click counters,
 *  redirect wrappers (a link carrying another link - an advertising
 *  platform's "track" is counting your click), the small print, and the "how
 *  did we do" buttons, which carry the parcel's own code with ?rate= on it. */
const NOT_TRACKING =
  /(\/wf\/open|\/open[/?]|[/._-](click|clicks|pixel|beacon|redirect|redir)\b|[?&][a-z_]*(url|redirect|dest|target)=https?(%3a|:)|[?&](rate|rating|score|vote)=|unsubscribe|opt-?out|preferences|feedback|review|survey|rate-?us|trustpilot|privacy|terms|cookie|\.(png|jpe?g|gif|svg|webp|ico)(\?|$))/i

export function carrierForHost(host: string): string | null {
  const lower = host.toLowerCase()
  return CARRIER_HOSTS.find(([pattern]) => pattern.test(lower))?.[1] ?? null
}

function parseUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.replace(/[.,;:!?'"]+$/, ''))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** Something in a link that names one parcel rather than a page anybody could
 *  open: at least six letters and digits with a digit among them, that is not
 *  the word "track" itself. */
function hasIdentifier(url: URL): boolean {
  const parts = [
    ...url.pathname.split('/'),
    ...[...url.searchParams.values()],
    ...url.hash.replace(/^#/, '').split(/[/?=&]/),
  ]
  return parts.some((part) => {
    const value = decodeURIComponentSafe(part).replace(/[^A-Za-z0-9]/g, '')
    return value.length >= 6 && /\d/.test(value) && !/track/i.test(value)
  })
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 'E32RS' or 'e3 2rs' as 'E3 2RS'; null for anything that is not a UK
 *  postcode. The inward part is always the last three characters. */
export function normalisePostcode(raw: string): string | null {
  const compact = raw.replace(/\s+/g, '').toUpperCase()
  if (!/^(GIR0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?\d[ABD-HJLNP-UW-Z]{2})$/.test(compact)) return null
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`
}

type LinkFind = TrackingCandidate & { postcode: string | null }

/** One link, as tracking, or null when it is not. */
export function readTrackingLink(raw: string): LinkFind | null {
  const url = parseUrl(raw)
  if (!url) return null
  const href = url.toString()
  if (NOT_TRACKING.test(href)) return null
  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)

  // DPD's follow-my-parcel link: the code is a session key on their feed.
  if (/(^|\.)dpd(local)?\.co\.uk$/.test(host) && segments[0] === 'd' && /^[A-Za-z0-9]{6,32}$/.test(segments[1] ?? '')) {
    // As the link itself, without anything on the end: the same code with a
    // query string is the same parcel.
    return { carrier: 'DPD', trackingNumber: null, trackingUrl: `${url.origin}/d/${segments[1]!}`, shortCode: segments[1]!, postcode: null }
  }
  // DPD's own tracking page: the parcel code, '12345678901234*00001', whose
  // leading digits are the parcel number.
  const dpdParcel = /track\.dpd\.co\.uk\/parcels\/(\d{8,20})/i.exec(href)
  if (dpdParcel) {
    return { carrier: 'DPD', trackingNumber: dpdParcel[1]!, trackingUrl: href, shortCode: null, postcode: null }
  }
  // AIT's short link, stored in the one shape shop keeps it in: no 'www.', no
  // query, whichever of their two sites it was given.
  const ait = AIT_HOST.exec(host)
  if (ait) {
    const code = segments.length === 1 ? segments[0]! : ''
    if (!AIT_CODE.test(code)) return null
    return { carrier: 'AIT', trackingNumber: null, trackingUrl: `https://aithd.${ait[1]!}/${code}`, shortCode: code, postcode: null }
  }
  // Multidrop-style: /<code>/<postcode>, the postcode with no space.
  if (host === 'multidrop.link' || host.endsWith('.multidrop.link')) {
    const [code, postcode] = segments
    if (code && /^[A-Za-z0-9]{4,32}$/.test(code)) {
      return {
        carrier: null,
        trackingNumber: null,
        trackingUrl: href,
        shortCode: code,
        postcode: postcode ? normalisePostcode(postcode) : null,
      }
    }
    return null
  }
  // Anything else: it has to say "track" somewhere and name a parcel.
  if (!/track/i.test(host + url.pathname + url.hash)) return null
  if (!hasIdentifier(url)) return null
  return { carrier: carrierForHost(host), trackingNumber: null, trackingUrl: href, shortCode: null, postcode: null }
}

// ---------------------------------------------------------------------------
// Numbers, references, days and slots beside their labels
// ---------------------------------------------------------------------------

const NUMBER_LABEL =
  /\b(?:consignment(?:\s+(?:number|no\.?|ref(?:erence)?))?|tracking\s+(?:number|no\.?|ref(?:erence)?|code|id)|parcel\s+(?:number|no\.?|id)|your\s+parcel|parcel|waybill(?:\s+(?:number|no\.?))?|air\s*way\s*bill|awb)\s*[:#.-]?(?:\s+|$)/gi

/** The value after a tracking label: letters then digits, or digits printed in
 *  spaced groups. Spaces and hyphens come out; it must be 8 to 30 characters
 *  with at least six digits, which a sentence never is. */
function trackingNumberAt(text: string): string | null {
  const match = /^([A-Z]{0,4}\d[A-Z\d]*(?:[ -]\d[A-Z\d]*)*)/i.exec(text.trim())
  if (!match) return null
  const compact = match[1]!.replace(/[ -]/g, '').toUpperCase()
  if (compact.length < 8 || compact.length > 30) return null
  if ((compact.match(/\d/g) ?? []).length < 6) return null
  return compact
}

const REF_LABEL =
  /\b(?:sales\s+order(?:\s+(?:number|no\.?))?|order\s+(?:number|no\.?|ref(?:erence)?))\s*[:#.-]?\s*/gi

const LOOSE_REF_LABEL =
  /\b(?:your\s+order(?:\s+(?:number|no\.?))?|our\s+(?:ref(?:erence)?|order(?:\s+(?:number|no\.?))?))\s*[:#.-]?\s*/gi

function refAt(text: string): string | null {
  const match = /^([A-Z]{0,3}-?\d{4,20})\b/i.exec(text.trim())
  return match ? match[1]!.toUpperCase() : null
}

const DATE_LABEL =
  /\b(?:delivery\s+(?:date|day)|deliver(?:ing|y)?\s+on|(?:is\s+)?scheduled\s+for|due\s+(?:for\s+delivery\s+)?on|expected\s+(?:delivery(?:\s+date)?|on)|estimated\s+delivery(?:\s+date)?|will\s+be\s+delivered\s+on|arriving\s+on|arrives\s+on)\b/i

const SLOT_LABEL = /\b(?:time\s*slot|delivery\s+window|window|between|eta|arriv\w*)\b/i

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

function isoDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null
  const daysIn = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day > daysIn) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y!, m! - 1, d! + days))
  return date.toISOString().slice(0, 10)
}

/** A day out of text. DD/MM/YYYY first (hand-parsed), then '8 September',
 *  then ISO, then today/tomorrow. A year left off is this year, or next year
 *  when that would put the day more than a month in the past. */
export function dayIn(text: string, today: string): string | null {
  const numeric = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b/.exec(text)
  if (numeric) {
    const year = numeric[3]!.length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3])
    return isoDay(year, Number(numeric[2]), Number(numeric[1]))
  }
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text)
  if (iso) return isoDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const named = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/i.exec(text)
  if (named) {
    const month = MONTHS[named[2]!.toLowerCase()]!
    const thisYear = Number(today.slice(0, 4))
    if (named[3]) return isoDay(Number(named[3]), month, Number(named[1]))
    const guess = isoDay(thisYear, month, Number(named[1]))
    if (!guess) return null
    return guess < addDays(today, -31) ? isoDay(thisYear + 1, month, Number(named[1])) : guess
  }
  if (/\btoday\b/i.test(text)) return today
  if (/\btomorrow\b/i.test(text)) return addDays(today, 1)
  return null
}

function hhmm(hours: number, minutes: number): string | null {
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function twelveHour(hours: number, meridiem: string | undefined): number {
  const m = (meridiem ?? '').toLowerCase()
  if (m === 'pm' && hours < 12) return hours + 12
  if (m === 'am' && hours === 12) return 0
  return hours
}

/** A window out of text: '10:00-13:00', '10:00 to 13:00', '1-4pm',
 *  '9am - 1pm'. The end has to come after the start. */
export function slotIn(text: string): [string, string] | null {
  const clock = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:-|–|to|and)\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/i.exec(text)
  if (clock) {
    const start = hhmm(Number(clock[1]), Number(clock[2]))
    const end = hhmm(Number(clock[3]), Number(clock[4]))
    return start && end && start < end ? [start, end] : null
  }
  const loose = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i.exec(text)
  if (loose) {
    // '1-4pm': the start takes the end's half of the day unless that would
    // put it after the end ('11-2pm' is eleven in the morning).
    const endHour = twelveHour(Number(loose[4]), loose[6])
    let startHour = twelveHour(Number(loose[1]), loose[3] ?? loose[6])
    if (!loose[3] && startHour > endHour) startHour = twelveHour(Number(loose[1]), 'am')
    const start = hhmm(startHour, Number(loose[2] ?? 0))
    const end = hhmm(endHour, Number(loose[5] ?? 0))
    return start && end && start < end ? [start, end] : null
  }
  return null
}

const ADDRESS_LABEL = /\b(?:delivery\s+address|deliver(?:ing|y)?\s+to|ship(?:ping)?\s+to|address)\b/i
const POSTCODE_IN_TEXT = /\b([A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?\s?\d[ABD-HJLNP-UW-Z]{2})\b/gi

// ---------------------------------------------------------------------------
// The whole email
// ---------------------------------------------------------------------------

function push<T>(list: T[], value: T | null, same: (a: T, b: T) => boolean = (a, b) => a === b): void {
  if (value !== null && !list.some((existing) => same(existing, value))) list.push(value)
}

/**
 * Everything an email says about a delivery.
 *
 * `today` is the site's own 'YYYY-MM-DD', for "out for delivery today" and for
 * a day written without its year.
 */
export function recogniseTracking(input: { subject: string; bodyText: string; today: string }): RecognisedTracking {
  const lines = ownLines(input.bodyText)
  const subject = input.subject.replace(/\s+/g, ' ').trim()

  // Links.
  const links: LinkFind[] = []
  for (const line of lines) {
    for (const match of line.matchAll(URL_PATTERN)) {
      push(links, readTrackingLink(match[0]), (a, b) => a.trackingUrl === b.trackingUrl || (a.shortCode !== null && a.shortCode === b.shortCode))
    }
  }

  // Numbers beside their labels, references, days, slots and postcodes.
  const numbers: string[] = []
  const supplierRefs: string[] = []
  const looseRefs: string[] = []
  const postcodes: string[] = []
  let deliveryDate: string | null = null
  let deliverySlot: [string, string] | null = null

  for (const [index, line] of [subject, ...lines].entries()) {
    const at = index - 1 // -1 is the subject, which has no line after it
    const following = (rest: string) => (at >= 0 ? withNext(lines, at, rest) : rest)

    for (const match of line.matchAll(NUMBER_LABEL)) {
      push(numbers, trackingNumberAt(following(line.slice(match.index! + match[0].length))))
    }
    for (const match of line.matchAll(REF_LABEL)) {
      push(supplierRefs, refAt(following(line.slice(match.index! + match[0].length))))
    }
    for (const match of line.matchAll(LOOSE_REF_LABEL)) {
      push(looseRefs, refAt(following(line.slice(match.index! + match[0].length))))
    }
    if (!deliveryDate) {
      const label = DATE_LABEL.exec(line)
      if (label) deliveryDate = dayIn(following(line.slice(label.index + label[0].length)), input.today)
    }
    if (!deliveryDate && /\b(?:out\s+for\s+delivery|(?:will\s+be\s+|being\s+)?delivered|delivering)\s+(?:today|tomorrow)\b/i.test(line)) {
      deliveryDate = dayIn(line, input.today)
    }
    if (!deliverySlot && SLOT_LABEL.test(line)) {
      deliverySlot = slotIn(following(line.slice((SLOT_LABEL.exec(line)?.index ?? 0))))
    }
    if (at >= 0 && ADDRESS_LABEL.test(line)) {
      // Links taken out first: a postcode inside a link is the link's to
      // vouch for, and it is counted with the link below.
      const block = [line.slice(ADDRESS_LABEL.exec(line)!.index), ...lines.slice(at + 1, at + 6)].join(' ').replace(URL_PATTERN, ' ')
      for (const match of block.matchAll(POSTCODE_IN_TEXT)) push(postcodes, normalisePostcode(match[1]!))
    }
  }
  const addressPostcodes = [...postcodes]
  for (const link of links) push(postcodes, link.postcode)

  // A number already inside one of the links is that link's parcel, not a
  // second one.
  const looseNumbers = numbers.filter((number) => !links.some((link) => link.trackingNumber === number))

  const candidates: TrackingCandidate[] = []
  if (links.length <= 1 && looseNumbers.length <= 1) {
    // The common case: one parcel, its link and its number printed separately.
    const link = links[0]
    const number = link?.trackingNumber ?? looseNumbers[0] ?? null
    if (link || number) {
      candidates.push({
        carrier: link?.carrier ?? null,
        trackingNumber: number,
        trackingUrl: link?.trackingUrl ?? null,
        shortCode: link?.shortCode ?? null,
      })
    }
  } else {
    for (const link of links) {
      candidates.push({ carrier: link.carrier, trackingNumber: link.trackingNumber, trackingUrl: link.trackingUrl, shortCode: link.shortCode })
    }
    for (const number of looseNumbers) {
      candidates.push({ carrier: null, trackingNumber: number, trackingUrl: null, shortCode: null })
    }
  }

  return {
    candidates,
    deliveryDate,
    // A window with no day is not a booking: "collect from them Monday to
    // Friday between 11 and 6" is opening hours.
    deliverySlot: deliveryDate ? deliverySlot : null,
    // A tracking number written beside "Order number" is still a tracking
    // number, not their reference.
    supplierRefs: supplierRefs.filter((ref) => !numbers.includes(ref)),
    looseRefs: looseRefs.filter((ref) => !numbers.includes(ref) && !supplierRefs.includes(ref)),
    postcodes,
    addressPostcodes,
  }
}

/**
 * Whose code a link's short code is: 'dpd' for any DPD host, 'multidrop' for a
 * Multidrop-style link, otherwise the link's own host. A short code means
 * something only to the service that issued it - a four-letter Multidrop code
 * and a DPD session code can coincide - so codes are only ever compared within
 * one of these. Null for no link.
 */
export function linkFamily(url: string | null | undefined): string | null {
  const parsed = url ? parseUrl(url) : null
  if (!parsed) return null
  const host = parsed.hostname.toLowerCase()
  if (/(^|\.)dpd(local)?\.(co\.uk|com|ie)$/.test(host)) return 'dpd'
  if (host === 'multidrop.link' || host.endsWith('.multidrop.link')) return 'multidrop'
  // Their two sites answer from different feeds, so a code is AIT's per site.
  const ait = AIT_HOST.exec(host)
  if (ait) return `aithd.${ait[1]!}`
  return host
}

/** The code as compared and stored: '<family>:<code>'. */
export function familyCode(url: string | null | undefined, code: string | null | undefined): string | null {
  const trimmed = (code ?? '').trim()
  if (!trimmed) return null
  return `${linkFamily(url) ?? 'unknown'}:${trimmed}`
}

/**
 * The one thing that says "this parcel", for finding it again: the number with
 * its spaces out, or failing that the code out of its link, scoped to whose
 * code it is. Null for a candidate with neither (a bare link to a page) - that
 * is still recordable, but a later email cannot be matched to it by anything
 * but the order.
 */
export function trackingKeyOf(
  candidate: Pick<TrackingCandidate, 'trackingNumber' | 'shortCode'> & { trackingUrl?: string | null },
): string | null {
  const number = (candidate.trackingNumber ?? '').replace(/[\s-]/g, '').toUpperCase()
  if (number) return number
  const code = familyCode(candidate.trackingUrl, candidate.shortCode)
  return code ? `CODE:${code}` : null
}

// ---------------------------------------------------------------------------
// Whose links to believe
// ---------------------------------------------------------------------------

/** Hosts known to belong to a carrier: the host table above (AIT's aithd
 *  links included), the
 *  Multidrop-style service, and the GFS scan page shop already reads. A link
 *  to one of these goes where it says. */
const KNOWN_TRACKING_HOSTS: readonly RegExp[] = [
  ...CARRIER_HOSTS.map(([pattern]) => pattern),
  /(^|\.)multidrop\.link$/,
  /(^|\.)justshoutgfs\.com$/,
]

/** The name a domain is registered under: 'mail.carrier.co.uk' is
 *  'carrier.co.uk', 'track.example.com' is 'example.com'. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.')
  if (labels.length <= 2) return labels.join('.')
  const twoPart = /^(co|org|ac|gov|ltd|plc|net|me|com|sch|nhs|police)$/.test(labels[labels.length - 2]!)
    && labels[labels.length - 1]!.length === 2
  return labels.slice(-(twoPart ? 3 : 2)).join('.')
}

/**
 * Whether a link in an email from a NON-supplier may be believed: it goes to a
 * known carrier, to a host the owner has listed, or to the sender's own domain
 * (a delivery firm linking its own page). Anybody on the internet can send an
 * email with a "tracking" link to a page of their own; this is what stops
 * that link reaching a customer's order. A supplier's own email is not put
 * through it.
 */
export function isTrustedTrackingLink(url: string, fromAddress: string, extraHosts: readonly string[] = []): boolean {
  const parsed = parseUrl(url)
  if (!parsed) return false
  const host = parsed.hostname.toLowerCase()
  if (KNOWN_TRACKING_HOSTS.some((pattern) => pattern.test(host))) return true
  if (extraHosts.some((extra) => {
    const listed = extra.trim().toLowerCase().replace(/^\*?\./, '')
    // A bare public suffix ("co.uk") would trust half the internet. The
    // setting refuses one when it is saved (a stored value that failed that
    // check would not get this far: parsePoConfig falls back to the defaults
    // whenever any field fails). Checked here as well for a caller that hands
    // hosts in directly.
    return listed !== '' && !isBarePublicSuffix(listed) && (host === listed || host.endsWith(`.${listed}`))
  })) return true
  const at = fromAddress.lastIndexOf('@')
  const senderHost = at >= 0 ? fromAddress.slice(at + 1).trim().toLowerCase() : ''
  if (senderHost === '') return false
  const senderDomain = registrableDomain(senderHost)
  // Anybody can have an address at a free email service, so sharing one with
  // the link proves nothing: bob@icloud.com linking icloud.com is still a
  // stranger's link.
  if (isFreeMailDomain(senderHost) || isFreeMailDomain(senderDomain)) return false
  return senderDomain === registrableDomain(host)
}

/** Second-level endings registered under a country code, "co.uk", "org.uk",
 *  "com.au" and the like. */
const TWO_PART_SUFFIX = /^(co|org|ac|gov|ltd|plc|net|me|com|sch|nhs|police|edu|mod)\.[a-z]{2}$/

/** Shared-hosting suffixes anybody can put a site under in minutes: as a
 *  trusted host each would trust every stranger's site there. A short fixed
 *  list of the common ones, not the whole public suffix list. */
const SHARED_HOSTING_SUFFIXES: ReadonlySet<string> = new Set([
  'vercel.app', 'netlify.app', 'github.io', 'pages.dev', 'herokuapp.com', 'web.app', 'firebaseapp.com',
  'azurewebsites.net', 'cloudfront.net', 's3.amazonaws.com', 'blogspot.com', 'wordpress.com', 'wixsite.com',
  'squarespace.com',
])

/**
 * Whether a host is nothing but a public suffix - "com", "co.uk", "org.uk" -
 * or one of the shared-hosting ones ("vercel.app", "github.io"), which as a
 * trusted host would cover every site registered under it.
 */
export function isBarePublicSuffix(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '')
  if (!value.includes('.')) return true
  return TWO_PART_SUFFIX.test(value) || SHARED_HOSTING_SUFFIXES.has(value)
}

/** A link's own postcode (Multidrop-style links carry one), for a caller
 *  rebuilding the postcode list after dropping a link it does not trust. */
export function linkPostcode(url: string): string | null {
  return readTrackingLink(url)?.postcode ?? null
}
