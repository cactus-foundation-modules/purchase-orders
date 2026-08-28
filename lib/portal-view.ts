import { withUnit } from './money'
import type { PoOrder, PoStatus } from './types'
import { PO_STATUS_LABELS } from './types'

// What a SUPPLIER is allowed to see and say, and the pure functions that build
// it.
//
// The projection is built field by field on purpose. Handing the PoOrder row
// itself to the portal would hand over notes_internal ("check they have not
// stitched us up on carriage again"), who approved it and at what level, and
// every audit line - none of which is theirs, and all of which would arrive the
// day somebody added a field to the row rather than the day anybody decided to
// share it. An allow-list cannot leak a field nobody has listed.
//
// CLIENT-SAFE. The panel on the portal page imports this, so nothing here may
// reach the database, next/headers or any server-only module.

export const PO_PORTAL_EVENT_KINDS = [
  'ACKNOWLEDGED',
  'DATE_PROPOSED',
  'SHORTAGE',
  'MESSAGE',
  'PROFORMA',
  'DESPATCHED',
] as const
export type PoPortalEventKind = (typeof PO_PORTAL_EVENT_KINDS)[number]

export const PO_PORTAL_EVENT_LABELS: Record<PoPortalEventKind, string> = {
  ACKNOWLEDGED: 'Accepted the order',
  DATE_PROPOSED: 'Offered a different date',
  SHORTAGE: 'Said something is short',
  MESSAGE: 'Left a message',
  PROFORMA: 'Sent their proforma',
  DESPATCHED: 'Despatched part of the order',
}

/** One line of the order as the supplier sees it in the panel. No money: the
 *  document above the panel already prints their own prices, and the panel only
 *  needs enough to point at a line. */
export type PoPortalLine = {
  id: string
  description: string
  supplierSku: string | null
  /** Ordered, less anything given up on. */
  qty: string
  unit: string
  /** The date THIS line is expected on, which on a part-shipped order is the
   *  only date that means anything - see the note on `expectedDate` below. */
  expectedDate: string | null
  /** How much of it they have already told us they have sent. */
  qtyDespatched: string
  /** What is left for them to send. Zero means the line is done as far as they
   *  are concerned, and the despatch form leaves it out. */
  qtyToSend: string
  /** A conscious addition to an otherwise tight allow-list: the supplier cannot
   *  send a line on the right service without being told which one. What that
   *  service costs stays behind - it is on the document as carriage, and a
   *  per-line figure beside it is nothing they need. */
  serviceName: string | null
}

/** One drop they have told us about, as it reads back to them. Money-free like
 *  everything else in here. */
export type PoPortalShipment = {
  id: string
  number: string
  despatchedDate: string
  carrier: string | null
  trackingRef: string | null
  lines: { description: string; qty: string; unit: string }[]
}

/** Where the proforma dance has got to, on an order that has one at all. */
export type PoPortalProforma = {
  /** False on every order to a supplier on a credit account, which is most of
   *  them - and the panel then says nothing about proformas at all. */
  required: boolean
  /** We have their invoice. */
  received: boolean
  /** We have paid it, which is their signal to confirm the order. */
  paid: boolean
  paidAt: string | null
  /** Their own reference for it, as they gave it to us. */
  ref: string | null
}

/** Something the supplier has already told us, as it reads back to them. */
export type PoPortalEvent = {
  id: string
  kind: PoPortalEventKind
  createdAt: string
  /** One line of plain English, built from the payload. */
  summary: string
}

export type PoPortalView = {
  orderNumber: string
  revision: number
  statusLabel: string
  /** A standing message from us to THIS supplier, set on their supplier record
   *  and shown at the top of their page. Null when nobody has written one, which
   *  is most suppliers. */
  note: string | null
  /** Whether the order is still one the supplier can say anything about. A
   *  cancelled or finished order is readable and nothing more. */
  open: boolean
  acknowledged: boolean
  acknowledgedAt: string | null
  /** Whether their own acknowledgement document is on file. */
  acknowledgementFiled: boolean
  requiredByDate: string | null
  /** The whole order's expected date. Still here, because an order that ships in
   *  one go has exactly one, but the LINE dates are what a part-shipping
   *  supplier actually answers with. */
  expectedDate: string | null
  proforma: PoPortalProforma
  /** Whether they may confirm the order right now, and why not when they may
   *  not. On proforma terms the answer is no until we have paid. */
  canAcknowledge: boolean
  acknowledgeBlockedReason: string | null
  /** Whether this site takes files and despatch notes through the link at all -
   *  both are switches in Purchase Orders settings. */
  canUpload: boolean
  canDespatch: boolean
  lines: PoPortalLine[]
  shipments: PoPortalShipment[]
  events: PoPortalEvent[]
}

/** One link, as the order screen lists it. Never the hash: no screen anywhere
 *  has any business showing that, and a type that cannot carry it is one fewer
 *  way for it to end up in a browser. */
export type PoPortalTokenSummary = {
  id: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  useCount: number
  createdByName: string | null
  /** Worked out on the server, so the list and the door agree on what "live"
   *  means. */
  live: boolean
}

/** One thing the supplier said, as the order screen lists it. The dates are
 *  named rather than left in the payload, because they are the one thing there
 *  is a button for. A whole-order date and a set of per-line ones both land
 *  here: older events carry the first, everything since carries the second. */
export type PoPortalAdminEvent = PoPortalEvent & {
  proposedDate: string | null
  proposedLines: { lineId: string; description: string; date: string }[]
}

/** The statuses a supplier may still act on. An order they have finished with,
 *  or one that has been cancelled, is theirs to read and nothing more. */
const OPEN_STATUSES: readonly PoStatus[] = ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'ON_HOLD']

export function isPortalOpen(status: PoStatus): boolean {
  return OPEN_STATUSES.includes(status)
}

/** A date as the supplier typed it, or null. Kept as a plain YYYY-MM-DD string
 *  the whole way: a Date here is a timezone waiting to move somebody's delivery
 *  a day. */
export function parsePortalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/** A quantity as it reads on a page: '4.000' is four. */
function tidyQty(value: string | number | null | undefined): string {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? String(n) : '0'
}

/** The dates in a DATE_PROPOSED payload, whichever shape it is in.
 *
 *  Two shapes exist and both are read for good: everything filed before per-line
 *  dates arrived carries one date for the whole order, and rewriting stored
 *  events to match a newer shape is how a history stops being a history. */
export function proposedLinesFrom(
  payload: Record<string, unknown>,
): { lineId: string; description: string; date: string }[] {
  const raw = Array.isArray(payload.lines) ? payload.lines : []
  return raw
    .map((row) => {
      const line = (row ?? {}) as Record<string, unknown>
      const date = parsePortalDate(line.date)
      if (!date) return null
      return {
        lineId: typeof line.lineId === 'string' ? line.lineId : '',
        description: typeof line.description === 'string' ? line.description : 'a line',
        date,
      }
    })
    .filter((row): row is { lineId: string; description: string; date: string } => row !== null)
}

/** One event as a sentence, for both the supplier's own list and the admin's. */
export function portalEventSummary(kind: PoPortalEventKind, payload: Record<string, unknown>): string {
  const note = typeof payload.note === 'string' ? payload.note.trim() : ''
  switch (kind) {
    case 'ACKNOWLEDGED': {
      const filed = payload.document === true
      const ref = typeof payload.ref === 'string' ? payload.ref.trim() : ''
      const opening = filed
        ? `Accepted the order and sent their acknowledgement${ref ? ` (${ref})` : ''}.`
        : 'Accepted the order.'
      return note ? `${opening.replace(/\.$/, '')}: ${note}` : opening
    }
    case 'DATE_PROPOSED': {
      const perLine = proposedLinesFrom(payload)
      if (perLine.length > 0) {
        const parts = perLine.map((row) => `${row.description} on ${row.date}`)
        const opening = `Offered new dates: ${parts.join('; ')}.`
        return note ? `${opening} ${note}` : opening
      }
      const date = parsePortalDate(payload.date)
      const opening = date ? `Offered ${date} instead.` : 'Offered a different date.'
      return note ? `${opening} ${note}` : opening
    }
    case 'SHORTAGE': {
      const lines = Array.isArray(payload.lines) ? payload.lines : []
      const parts = lines
        .map((line) => {
          const row = (line ?? {}) as Record<string, unknown>
          const what = typeof row.description === 'string' ? row.description : 'a line'
          const qty = typeof row.qty === 'string' ? row.qty : ''
          return qty ? `${what} (${qty} short)` : what
        })
        .filter(Boolean)
      const opening = parts.length ? `Short on ${parts.join('; ')}.` : 'Said something is short.'
      return note ? `${opening} ${note}` : opening
    }
    case 'MESSAGE': {
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      // Which lines they meant, when they picked some. Named before the message
      // rather than after it, because "about the oak desks:" is what tells
      // somebody here whether this one is theirs to answer.
      const lines = Array.isArray(payload.lines) ? payload.lines : []
      const about = lines
        .map((line) => {
          const row = (line ?? {}) as Record<string, unknown>
          return typeof row.description === 'string' ? row.description : ''
        })
        .filter(Boolean)
      return about.length ? `About ${about.join('; ')}: ${text}` : text
    }
    case 'PROFORMA': {
      const ref = typeof payload.ref === 'string' ? payload.ref.trim() : ''
      const amount = typeof payload.amount === 'string' ? payload.amount.trim() : ''
      const bits = [ref && `their ${ref}`, amount && `for ${amount}`].filter(Boolean).join(' ')
      const opening = bits ? `Sent their proforma, ${bits}.` : 'Sent their proforma invoice.'
      return note ? `${opening} ${note}` : opening
    }
    case 'DESPATCHED': {
      const number = typeof payload.number === 'string' ? payload.number : ''
      const date = parsePortalDate(payload.date)
      const lines = Array.isArray(payload.lines) ? payload.lines : []
      const parts = lines
        .map((line) => {
          const row = (line ?? {}) as Record<string, unknown>
          const what = typeof row.description === 'string' ? row.description : 'a line'
          const qty = typeof row.qty === 'string' ? row.qty : ''
          return qty ? `${qty} x ${what}` : what
        })
        .filter(Boolean)
      const carrier = typeof payload.carrier === 'string' ? payload.carrier.trim() : ''
      const tracking = typeof payload.trackingRef === 'string' ? payload.trackingRef.trim() : ''
      const head = `Despatched${number ? ` ${number}` : ''}${date ? ` on ${date}` : ''}`
      const what = parts.length ? `: ${parts.join('; ')}` : ''
      const how = [carrier, tracking && `tracking ${tracking}`].filter(Boolean).join(', ')
      const opening = `${head}${what}.${how ? ` ${how[0]!.toUpperCase()}${how.slice(1)}.` : ''}`
      return note ? `${opening} ${note}` : opening
    }
  }
}

/** Everything the view needs that does not live on the order row: what they have
 *  despatched, and which of the two portal switches this site has on. */
export type PortalViewExtras = {
  /** The supplier's own standing message, read live off their record. */
  note?: string | null
  shipments?: PoPortalShipment[]
  /** orderLineId -> how much of it has been despatched. */
  despatchedByLine?: Record<string, string>
  uploadsEnabled?: boolean
  despatchEnabled?: boolean
}

/**
 * The order as the supplier's panel receives it.
 *
 * Every field named one at a time. Nothing is spread in from the order row, and
 * nothing should ever be: the test beside this file asserts that an order
 * carrying internal notes and an approval trail comes out the other side with
 * neither.
 */
export function portalView(
  order: PoOrder,
  events: PoPortalEvent[],
  extras: PortalViewExtras = {},
): PoPortalView {
  const despatched = extras.despatchedByLine ?? {}

  const proforma: PoPortalProforma = {
    required: Boolean(order.proformaRequired),
    received: Boolean(order.proformaMediaId) || Boolean(order.proformaReceivedAt),
    paid: Boolean(order.proformaPaidAt),
    paidAt: order.proformaPaidAt,
    ref: order.proformaRef,
  }

  // On proforma terms the order is not theirs to confirm until we have paid, and
  // saying so on the page is the whole reason the terms are recorded. It is a
  // gate rather than a hint: a supplier who confirms before the money moves is
  // exactly the confusion this is meant to stop.
  const waitingOnProforma = proforma.required && !proforma.paid
  const acknowledgeBlockedReason = !waitingOnProforma
    ? null
    : proforma.received
      ? 'We have your proforma and it is with us to pay. Once it is paid you can confirm the order here.'
      : 'Send us your proforma first. We will pay it, and then you can confirm the order here.'

  return {
    orderNumber: order.number,
    revision: order.revision,
    statusLabel: PO_STATUS_LABELS[order.status] ?? order.status,
    note: extras.note ?? null,
    open: isPortalOpen(order.status),
    acknowledged: Boolean(order.acknowledgedAt),
    acknowledgedAt: order.acknowledgedAt,
    acknowledgementFiled: Boolean(order.ackMediaId),
    requiredByDate: order.requiredByDate,
    expectedDate: order.expectedDate,
    proforma,
    canAcknowledge: !waitingOnProforma,
    acknowledgeBlockedReason,
    canUpload: extras.uploadsEnabled !== false,
    canDespatch: extras.despatchEnabled !== false,
    lines: order.lines
      // A line given up on entirely is not one they can be short of.
      .filter((line) => Number(line.qty) - Number(line.qtyCancelled) > 0)
      .map((line) => {
        const qty = Number(line.qty) - Number(line.qtyCancelled)
        const sent = Number(despatched[line.id] ?? 0)
        return {
          id: line.id,
          description: line.description,
          supplierSku: line.supplierSku,
          qty: String(qty),
          unit: line.unit,
          expectedDate: line.expectedDate,
          qtyDespatched: tidyQty(sent),
          qtyToSend: tidyQty(Math.max(0, qty - sent)),
          serviceName: line.serviceName,
        }
      }),
    shipments: extras.shipments ?? [],
    events,
  }
}

/**
 * A quantity as typed, in thousandths - which is the precision
 * po_order_lines.qty is stored at.
 *
 * Whole numbers, so two quantities compare as the different numbers they are
 * rather than as two floats that nearly agree: 4.001 against 4 is a real
 * difference and 4 against 4.0 is not, and `>` on the raw Numbers gets the
 * second of those wrong often enough to matter.
 *
 * NaN for anything unreadable, which every caller treats as "no".
 */
export function qtyThousandths(value: string | number | null | undefined): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? Math.round(n * 1000) : Number.NaN
}

/** A quantity with its unit, the way it reads in a sentence: "4", "2.5 m". The
 *  unit goes through unitLabel(), so the column default prints as nothing at
 *  all - "you cannot be short of more than 4" is the sentence, not "4 each". */
export function qtyWithUnit(qty: string | number | null | undefined, unit: string | null | undefined): string {
  const n = Number(qty ?? 0)
  return withUnit(Number.isFinite(n) ? String(n) : '0', unit)
}

/**
 * Why a quantity a supplier has typed against a line is not one we can take, or
 * null when it is fine.
 *
 * One function for both forms, because "you cannot say more than is left" is the
 * same rule whether they are telling us a line is short or telling us it has
 * gone - and it is a rule the panel and the endpoint have to agree on to the
 * letter. The panel shows it under the box as they type; the endpoint says the
 * same thing back to anything that posts round the panel.
 */
export function qtyProblem(
  typed: string,
  left: string | number,
  what: { description: string; unit: string | null },
  doing: 'short' | 'sending',
): string | null {
  const trimmed = typed.trim()
  if (trimmed === '') return null
  const want = qtyThousandths(trimmed)
  if (!Number.isFinite(want) || want <= 0) return 'Put a number in that is more than nothing.'
  const cap = qtyThousandths(left)
  if (!Number.isFinite(cap) || cap <= 0) {
    return doing === 'short'
      ? `There is none of ${what.description} left on this order to be short of.`
      : `There is none of ${what.description} left to send.`
  }
  if (want <= cap) return null
  const remaining = qtyWithUnit(left, what.unit)
  return doing === 'short'
    ? `Only ${remaining} of ${what.description} is left on this order, so you cannot be short of more than that.`
    : `Only ${remaining} of ${what.description} is left to send, so you cannot send more than that.`
}

/** What the supplier is telling us, said back to them as they type it: "1 of 4
 *  out of stock", "2 of 4 being sent". The whole point of the line is that a
 *  number in a box on its own does not say which of the two it is. */
export function qtySaying(
  typed: string,
  left: string | number,
  unit: string | null,
  doing: 'short' | 'sending',
): string | null {
  const want = Number(typed.trim())
  if (!typed.trim() || !Number.isFinite(want) || want <= 0) return null
  const cap = Number(left)
  const of = Number.isFinite(cap) && cap > 0 ? ` of ${qtyWithUnit(cap, unit)}` : ''
  return doing === 'short' ? `${want}${of} out of stock` : `${want}${of} being sent`
}
