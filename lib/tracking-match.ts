import {
  familyCode, isTrustedTrackingLink, linkPostcode, trackingKeyOf, type RecognisedTracking, type TrackingCandidate,
} from './tracking-recognise'
import type { PoStatus } from './types'

// Which of our purchase orders an email's tracking belongs to - or that it
// belongs to none, or that a person should say.
//
// PURE, like lib/inbound-filing.ts: lib/inbound-tracking.ts fetches the orders
// and the despatches and asks this. Strongest rule first:
//
//  1. Our purchase order number in the subject or the body. (The supplier
//     replying on the order's thread.) Exactly one, on an order to that
//     supplier. Only a supplier may use this rule: anybody can type a number
//     that looks like ours.
//  2. The supplier's own reference we already hold - their sales order number
//     (`ack_ref`) or their proforma number - compared with leading zeros taken
//     off, because a delivery firm prints "123456" for sales order
//     "0000123456". Exactly one order.
//  3. A parcel number or follow-my-parcel code already on one of our
//     despatches. (Later news about a parcel already recorded.)
//  4. The delivery postcode alone, when exactly one open drop-ship order to
//     that postcode is still waiting to be despatched - or is despatched and
//     still waiting to hear its delivery slot, which is when a delivery firm's
//     timeslot email arrives quoting nothing but its link and the postcode.
//
// Rules 1-3 apply the tracking by themselves, within the two guards on
// matchTracking below (a postcode that disagrees, and a stranger being the
// first word that goods have gone). Rule 4 only PROPOSES it: a wrong match
// there emails one customer another customer's delivery, which is not a
// mistake the site gets to make twice, so a person says "yes, that one".
//
// And who sent it:
//  - a supplier (lib/inbound-filing.ts matchSender) may use all four, each
//    narrowed to that supplier's own orders;
//  - anybody else - the carrier, the delivery firm - may use rules 2-4, only
//    when the email actually carries tracking, only the plain order-number
//    labels for rule 2 (never "your order" or "our ref", which on a courier's
//    email are the courier's own numbers), and only a reference of six or more
//    characters or one whose order's postcode the email agrees with. That is how carrier mail is
//    recognised as carrier mail: by what is in it, not by a list of carriers'
//    addresses, so it works for carriers nobody has configured;
//  - our own colleagues writing to each other are ignored outright.

/** One of our orders, as far as matching needs it. */
export type TrackingOrder = {
  id: string
  number: string
  supplierId: string
  status: PoStatus
  /** Going straight to the customer (ship-to CUSTOMER). */
  dropShip: boolean
  /** The ship-to postcode, normalised, or null. */
  postcode: string | null
  /** The supplier's own references we hold: ack_ref, proforma_ref. */
  supplierRefs: readonly string[]
  /** Something on it has not been despatched yet. */
  awaitingDespatch: boolean
  /** It has a recent despatch with no delivery slot on it yet: a delivery
   *  firm's "your timeslot is confirmed" email, which often quotes nothing but
   *  its link and the postcode, may still be about it. */
  awaitingDeliveryNews: boolean
  /** Anything at all has been recorded as despatched on it. */
  hasDespatch: boolean
}

/** One of our despatches, as far as matching needs it. */
export type TrackingDespatch = {
  id: string
  orderId: string
  trackingKey: string | null
  trackingRef: string | null
  trackingCode: string | null
  trackingUrl: string | null
}

export type SenderKind = 'supplier' | 'internal' | 'other'

export type TrackingMatch =
  | { kind: 'apply'; rule: 1 | 2 | 3; order: TrackingOrder; despatchId: string | null }
  | { kind: 'propose'; rule: 1 | 2 | 3 | 4; order: TrackingOrder; reason: string }
  | { kind: 'ignore'; reason: string }

/** The order states a despatch makes sense in: sent, and not finished with.
 *  A draft has not gone to them; a cancelled or closed order is done. An
 *  invoiced order (PENDING_CLOSE) still takes one - a drop-shipper's invoice
 *  often arrives before the van does. */
export const DESPATCH_STATES: readonly PoStatus[] = [
  'SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'RECEIVED', 'PENDING_CLOSE', 'ON_HOLD',
]

/** Their reference as it is compared: upper case, nothing but letters and
 *  digits, leading zeros off. */
export function normaliseRef(ref: string): string {
  return ref.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '')
}

/** Our order numbers quoted in the text, exactly as we issued them. Looked up
 *  rather than pattern-matched, like lib/supplier-document.ts does for their
 *  paperwork: immune to how anybody formats a number, and never fooled by
 *  "PO-00012" inside "PO-000123". */
export function poNumbersIn(text: string, known: Iterable<string>): string[] {
  const upper = text.toUpperCase()
  const found: string[] = []
  for (const number of known) {
    const needle = number.toUpperCase()
    let from = 0
    for (;;) {
      const at = upper.indexOf(needle, from)
      if (at < 0) break
      const before = at === 0 ? '' : upper[at - 1]!
      const after = upper[at + needle.length] ?? ''
      if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) {
        found.push(number)
        break
      }
      from = at + 1
    }
  }
  return found
}

/** Every key a candidate could be found again by. Codes are scoped to whose
 *  code they are ('multidrop:Q9XZ7A'), so a short code from one service never
 *  matches another's. */
type CandidateKeys = { numbers: Set<string>; codes: Set<string>; urls: Set<string> }

function candidateKeys(found: RecognisedTracking): CandidateKeys {
  const numbers = new Set<string>()
  const codes = new Set<string>()
  const urls = new Set<string>()
  for (const candidate of found.candidates) {
    const key = trackingKeyOf({ trackingNumber: candidate.trackingNumber, shortCode: null })
    if (key) numbers.add(key)
    const code = familyCode(candidate.trackingUrl, candidate.shortCode)
    if (code) codes.add(code)
    if (candidate.trackingUrl) urls.add(candidate.trackingUrl)
  }
  return { numbers, codes, urls }
}

function despatchMatches(despatch: TrackingDespatch, keys: CandidateKeys): boolean {
  const ref = (despatch.trackingRef ?? '').replace(/[\s-]/g, '').toUpperCase()
  if (ref && keys.numbers.has(ref)) return true
  if (despatch.trackingKey && keys.numbers.has(despatch.trackingKey)) return true
  const code = familyCode(despatch.trackingUrl, despatch.trackingCode)
  if (code && keys.codes.has(code)) return true
  if (despatch.trackingKey?.startsWith('CODE:') && keys.codes.has(despatch.trackingKey.slice(5))) return true
  // A bare link with no number or code in it is its own key: the same link
  // twice is the same parcel.
  if (despatch.trackingUrl && keys.urls.has(despatch.trackingUrl)) return true
  return false
}

/** The despatch on this order the email is news about, if any. */
export function despatchFor(
  orderId: string,
  found: RecognisedTracking,
  despatches: readonly TrackingDespatch[],
): TrackingDespatch | null {
  const keys = candidateKeys(found)
  return despatches.find((d) => d.orderId === orderId && despatchMatches(d, keys)) ?? null
}

/** Whether the email's own delivery postcodes agree with where the order is
 *  going. 'unknown' when either side has none to compare. */
export function postcodeVerdict(order: TrackingOrder, found: RecognisedTracking): 'agree' | 'disagree' | 'unknown' {
  if (found.postcodes.length === 0 || order.postcode === null) return 'unknown'
  return found.postcodes.includes(order.postcode) ? 'agree' : 'disagree'
}

/** A reference long enough to mean one order: six letters and digits once its
 *  leading zeros are off. "1234" is any number of things; "967920" is one. */
export const SIGNIFICANT_REF_LENGTH = 6

function mismatch(order: TrackingOrder, found: RecognisedTracking): string {
  return (
    `It looks like ${order.number}'s delivery, but it gives the delivery postcode as ${found.postcodes.join(' or ')} ` +
    `and ${order.number} is going to ${order.postcode}. Check it is that customer's delivery before it is recorded.`
  )
}

/**
 * Where the tracking in one email goes.
 *
 * `text` is the subject and the email's own body, for rule 1. `supplierIds` are
 * the suppliers the sender could be (empty for anybody else). `orders` are our
 * orders worth matching against, every supplier's; `despatches` every despatch
 * on them that carries tracking. `linkDropped` says the caller threw away a
 * link it did not trust (see isTrustedTrackingLink).
 *
 * Two guards on top of the rules, both about not putting one customer's
 * delivery on another's order:
 *
 *  - When the email gives a delivery postcode and the order is going somewhere
 *    else, rules 1, 2 and 3 do not apply it - they propose it, with the mismatch
 *    said.
 *  - Somebody who is not the supplier is never, by themselves, the first word
 *    that an order's goods have gone. On an order with nothing despatched yet,
 *    their email applies only by rule 2 with the postcode agreeing and every
 *    link in it believed; and wherever what is left after dropping a link
 *    would start a new despatch, it is proposed instead.
 */
export function matchTracking(input: {
  sender: SenderKind
  supplierIds: readonly string[]
  text: string
  found: RecognisedTracking
  orders: readonly TrackingOrder[]
  despatches: readonly TrackingDespatch[]
  linkDropped?: boolean
}): TrackingMatch {
  const { sender, supplierIds, found } = input
  const linkDropped = input.linkDropped ?? false
  if (sender === 'internal') return { kind: 'ignore', reason: 'An email between colleagues here, so not read for tracking.' }

  const hasTracking = found.candidates.length > 0
  const hasNews = hasTracking || found.deliveryDate !== null || found.deliverySlot !== null
  if (!hasNews) return { kind: 'ignore', reason: 'No delivery tracking in it.' }
  if (sender === 'other' && !hasTracking) {
    return { kind: 'ignore', reason: 'Not from a supplier, and no tracking number or link in it.' }
  }

  const mine = (order: TrackingOrder) => sender !== 'supplier' || supplierIds.includes(order.supplierId)
  const live = (order: TrackingOrder) => DESPATCH_STATES.includes(order.status)
  const pool = input.orders.filter(mine)
  const keys = candidateKeys(found)
  const despatchOn = (order: TrackingOrder) =>
    input.despatches.find((d) => d.orderId === order.id && despatchMatches(d, keys))?.id ?? null

  /** An apply, unless a stranger would be starting the order's despatch on
   *  weaker evidence than rule 2 with the postcode agreeing. */
  const applied = (rule: 1 | 2 | 3, order: TrackingOrder): TrackingMatch => {
    const despatchId = despatchOn(order)
    if (sender === 'other' && despatchId === null) {
      const strong = rule === 2 && postcodeVerdict(order, found) === 'agree' && !linkDropped
      if (!order.hasDespatch && !strong) {
        return {
          kind: 'propose', rule, order,
          reason: `Not from the supplier, and the first word that ${order.number} has gone. Check it is that order's delivery before it is recorded - it will reach the customer's order.`,
        }
      }
      if (order.awaitingDespatch && linkDropped) {
        return {
          kind: 'propose', rule, order,
          reason: `A link in it went somewhere that is not a known carrier, so it was left out, and what is left would record a new despatch on ${order.number}. Check it before it is recorded.`,
        }
      }
    }
    return { kind: 'apply', rule, order, despatchId }
  }

  // 1. Our order number, from a supplier, on one of theirs.
  if (sender === 'supplier') {
    const quoted = new Set(poNumbersIn(input.text, input.orders.map((o) => o.number)))
    const theirs = pool.filter((order) => quoted.has(order.number))
    if (theirs.length === 1) {
      const order = theirs[0]!
      if (!live(order)) return { kind: 'ignore', reason: `It is about ${order.number}, which is not expecting a delivery.` }
      if (postcodeVerdict(order, found) === 'disagree') return { kind: 'propose', rule: 1, order, reason: mismatch(order, found) }
      return applied(1, order)
    }
    if (theirs.length > 1) {
      return { kind: 'ignore', reason: `It quotes ${theirs.length} of our orders (${theirs.map((o) => o.number).join(', ')}), so which delivery this is cannot be told.` }
    }
  }

  // Rules 2 to 4 are about a parcel, so they need tracking in the email.
  if (!hasTracking) return { kind: 'ignore', reason: 'A delivery date with no tracking and none of our order numbers, so it cannot be placed.' }

  // 2. Their own reference. A supplier's own email may use the looser labels;
  //    anybody else's only the plain order-number ones, and then only a long
  //    reference or one whose order's postcode the email agrees with.
  const printed = sender === 'supplier' ? [...found.supplierRefs, ...found.looseRefs] : found.supplierRefs
  const refs = new Set(printed.map(normaliseRef).filter((ref) => ref.length >= 4))
  if (refs.size > 0) {
    const byRef = pool.filter((order) => {
      const hits = order.supplierRefs.map(normaliseRef).filter((ref) => refs.has(ref))
      if (hits.length === 0) return false
      if (sender === 'supplier') return true
      return hits.some((ref) => ref.length >= SIGNIFICANT_REF_LENGTH) || postcodeVerdict(order, found) === 'agree'
    })
    if (byRef.length === 1) {
      const order = byRef[0]!
      if (!live(order)) return { kind: 'ignore', reason: `It is about ${order.number}, which is not expecting a delivery.` }
      if (postcodeVerdict(order, found) === 'disagree') return { kind: 'propose', rule: 2, order, reason: mismatch(order, found) }
      return applied(2, order)
    }
    if (byRef.length > 1) {
      return { kind: 'ignore', reason: `Their reference matches ${byRef.length} of our orders, so which one is not certain.` }
    }
  }

  // 3. A parcel already on one of our despatches.
  const known = new Set(
    input.despatches.filter((d) => despatchMatches(d, keys)).map((d) => d.orderId),
  )
  const byParcel = pool.filter((order) => known.has(order.id))
  if (byParcel.length === 1) {
    const order = byParcel[0]!
    if (postcodeVerdict(order, found) === 'disagree') return { kind: 'propose', rule: 3, order, reason: mismatch(order, found) }
    return applied(3, order)
  }
  if (byParcel.length > 1) {
    return { kind: 'ignore', reason: 'That parcel is already on more than one of our orders, so it has been left alone.' }
  }

  // 4. The postcode, and only ever as a question.
  const postcodes = new Set(found.postcodes)
  if (postcodes.size > 0) {
    const byPostcode = pool.filter(
      (order) => order.dropShip && (order.awaitingDespatch || order.awaitingDeliveryNews) && live(order)
        && order.postcode !== null && postcodes.has(order.postcode),
    )
    if (byPostcode.length === 1) {
      const order = byPostcode[0]!
      return {
        kind: 'propose', rule: 4, order,
        reason: `Delivery tracking matched to ${order.number} by its delivery postcode alone. Check it is that customer's delivery before it is recorded - it will reach their order.`,
      }
    }
    if (byPostcode.length > 1) {
      return { kind: 'ignore', reason: `The delivery postcode matches ${byPostcode.length} of our orders waiting to go, so which one is not certain.` }
    }
  }

  return { kind: 'ignore', reason: 'Tracking, but nothing in it matches one of our orders.' }
}

/**
 * The email's tracking with every link a stranger cannot be believed about
 * taken out: the link, the code that came with it and the postcode it carried.
 * A candidate left with nothing is dropped. `linkDropped` says whether
 * anything was.
 */
export function believedLinks(
  read: RecognisedTracking,
  fromAddress: string,
  extraHosts: readonly string[],
): { found: RecognisedTracking; linkDropped: boolean } {
  let linkDropped = false
  const candidates: TrackingCandidate[] = []
  for (const candidate of read.candidates) {
    if (candidate.trackingUrl && !isTrustedTrackingLink(candidate.trackingUrl, fromAddress, extraHosts)) {
      linkDropped = true
      if (candidate.trackingNumber) candidates.push({ ...candidate, trackingUrl: null, shortCode: null })
      continue
    }
    candidates.push(candidate)
  }
  const postcodes = [...read.addressPostcodes]
  for (const candidate of candidates) {
    const postcode = candidate.trackingUrl ? linkPostcode(candidate.trackingUrl) : null
    if (postcode && !postcodes.includes(postcode)) postcodes.push(postcode)
  }
  return { found: { ...read, candidates, postcodes }, linkDropped }
}
