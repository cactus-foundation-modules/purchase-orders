import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { calendarDateIn } from '@/lib/config/timezone'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { recordAudit } from './audit'
import { getPoConfigCached, trackingLinkHostList } from './config'
import {
  notifyDespatchRecorded,
  type DespatchRecordedEvent,
  type DespatchRecordedObserver,
} from './despatch-hooks'
import { domainOf, matchSender, type SenderSupplier } from './inbound-filing'
import { carrierForHost, normalisePostcode, ownLines, recogniseTracking, trackingKeyOf } from './tracking-recognise'
import type { RecognisedTracking, TrackingCandidate } from './tracking-recognise'
import {
  believedLinks,
  DESPATCH_STATES,
  despatchFor,
  matchTracking,
  type SenderKind,
  type TrackingDespatch,
  type TrackingMatch,
  type TrackingOrder,
} from './tracking-match'
import type { PoStatus } from './types'

// Delivery tracking that arrives by email, recorded as a despatch on the
// purchase order it belongs to, and announced to whoever is waiting for it.
//
// The inbox handler (lib/inbound-handler.ts) calls this for every inbound
// email once the owner has switched it on. The inline work is cheap: read the
// text (lib/tracking-recognise.ts), and for nearly every email that is the end
// of it - no tracking, nothing to do. When there IS tracking, two small reads
// (our orders worth matching, and the despatches already carrying tracking),
// one decision (lib/tracking-match.ts), and one short transaction.
//
// Idempotent from end to end, because the inbox offers an email again whenever
// it is unsure the first offer finished, and may offer it twice at once:
//
//  - the despatch is written under a row lock on its order, so two runs about
//    one order take turns, and the second finds the first one's despatch;
//  - behind that, a unique index on (order_id, tracking_key) means one parcel
//    is one despatch on an order whatever happens to the lock;
//  - what was announced is a fingerprint on the despatch, swapped with a
//    compare-and-set, so a duplicate email announces nothing;
//  - the row this leaves on po_inbound_documents is keyed on the email, so the
//    inbox's second offer writes nothing new and is told the same thing.
//
// Nothing here sends anybody an email or moves money. It records what the
// supplier's carrier said, and tells the modules that asked to be told.

/** What a tracking row keeps of the email: what was read, and what came of it. */
export type TrackingDetail = {
  candidate: TrackingCandidate | null
  deliveryDate: string | null
  deliverySlot: [string, string] | null
  supplierRefs: string[]
  postcodes: string[]
  /** The day the email was sent, in the site's timezone: the despatch date. */
  sentDay: string
  rule: number | null
  /** The one line said back to the conversation. */
  note: string | null
}

/** Rows this leaves are keyed `tracking:<message id>`, page 0, in the same
 *  table as the paperwork, so the Paperwork list shows the proposals. */
export function trackingRowKey(messageId: string): string {
  return `tracking:${messageId}`
}

// ---------------------------------------------------------------------------
// Who sent it
// ---------------------------------------------------------------------------

/**
 * A supplier (by Stage D's own rules), one of our colleagues, or anybody else.
 *
 * Internal means the sender's domain is one the email was sent to: a colleague
 * here forwarding a carrier's email to the purchasing address. Read for nothing.
 */
export function senderKind(
  fromAddress: string,
  recipients: readonly string[],
  suppliers: readonly SenderSupplier[],
): { kind: SenderKind; supplierIds: string[] } {
  const supplierIds = matchSender(fromAddress, suppliers, recipients)
  if (supplierIds.length > 0) return { kind: 'supplier', supplierIds }
  const domain = domainOf(fromAddress)
  if (!domain) return { kind: 'other', supplierIds: [] }
  const ours = new Set(recipients.map(domainOf).filter((d): d is string => d !== null))
  return { kind: ours.has(domain) ? 'internal' : 'other', supplierIds: [] }
}

/**
 * Who is carrying it, when the email does not say: for carrier mail, the
 * sender's own name for itself - "delivery@deliveryfirm.example" is
 * Deliveryfirm. Never for a supplier's own email (they are not the carrier).
 */
export function carrierFromSender(fromAddress: string): string | null {
  const domain = domainOf(fromAddress)
  if (!domain) return null
  const named = carrierForHost(domain)
  if (named) return named
  const labels = domain.split('.')
  // The registrable name: the label before a two-part ending like .co.uk, or
  // before a one-part ending like .com.
  const twoPart = labels.length >= 3 && /^(co|org|ac|gov|ltd|plc|net|me|com)$/.test(labels[labels.length - 2]!)
  const name = labels[labels.length - (twoPart ? 3 : 2)]
  if (!name || name.length < 2) return null
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// ---------------------------------------------------------------------------
// The two reads
// ---------------------------------------------------------------------------

/**
 * Our orders worth matching against, every supplier's: everything sent and
 * not long finished. Closed and cancelled ones for six months, so an email
 * quoting one is answered by name ("not expecting a delivery") rather than
 * missed.
 */
export async function trackingOrders(): Promise<TrackingOrder[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."id", o."number", o."supplier_id", o."status", o."ship_to_kind",
           o."ship_to"->'address'->>'postcode' AS "postcode",
           o."ack_ref", o."proforma_ref",
           EXISTS (
             SELECT 1 FROM "po_order_lines" l
              WHERE l."order_id" = o."id"
                AND l."qty" - l."qty_cancelled" > COALESCE((
                  SELECT SUM(sl."qty") FROM "po_shipment_lines" sl WHERE sl."order_line_id" = l."id"
                ), 0)
           ) AS "awaiting",
           EXISTS (
             SELECT 1 FROM "po_shipments" d
              WHERE d."order_id" = o."id"
                AND d."delivery_slot_start" IS NULL
                AND d."created_at" > now() - interval '30 days'
           ) AS "awaiting_news",
           EXISTS (SELECT 1 FROM "po_shipments" d WHERE d."order_id" = o."id") AS "has_despatch"
      FROM "po_orders" o
     WHERE o."status" NOT IN ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED')
       AND (o."status" NOT IN ('CLOSED', 'CANCELLED') OR o."updated_at" > now() - interval '180 days')
  `
  return rows.map((r) => ({
    id: r.id as string,
    number: r.number as string,
    supplierId: r.supplier_id as string,
    status: r.status as PoStatus,
    dropShip: r.ship_to_kind === 'CUSTOMER',
    postcode: normalisePostcode(String(r.postcode ?? '')),
    supplierRefs: [r.ack_ref, r.proforma_ref].filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
    awaitingDespatch: Boolean(r.awaiting),
    awaitingDeliveryNews: Boolean(r.awaiting_news),
    hasDespatch: Boolean(r.has_despatch),
  }))
}

/** Every recent despatch with any tracking on it, for rule 3. */
export async function trackedDespatches(): Promise<TrackingDespatch[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "order_id", "tracking_key", "tracking_ref", "tracking_code", "tracking_url"
      FROM "po_shipments"
     WHERE ("tracking_key" IS NOT NULL OR "tracking_ref" IS NOT NULL OR "tracking_code" IS NOT NULL
            OR "tracking_url" IS NOT NULL)
       AND "created_at" > now() - interval '180 days'
  `
  return rows.map((r) => ({
    id: r.id as string,
    orderId: r.order_id as string,
    trackingKey: (r.tracking_key as string | null) ?? null,
    trackingRef: (r.tracking_ref as string | null) ?? null,
    trackingCode: (r.tracking_code as string | null) ?? null,
    trackingUrl: (r.tracking_url as string | null) ?? null,
  }))
}

// ---------------------------------------------------------------------------
// Recording the despatch
// ---------------------------------------------------------------------------

export type RecordInput = {
  orderId: string
  candidate: TrackingCandidate | null
  deliveryDate: string | null
  deliverySlot: [string, string] | null
  sentDay: string
  messageId: string
  /** A person who said "yes, that one" on the Paperwork list, else null. */
  userId: string | null
}

export type RecordResult =
  | { kind: 'created'; despatchId: string; number: string }
  | { kind: 'updated'; despatchId: string; number: string; changed: string[] }
  | { kind: 'unchanged'; despatchId: string; number: string }
  | { kind: 'refused'; reason: string }

// Narrow enough that the transaction client satisfies it.
type TxClient = Pick<typeof prisma, '$queryRaw'>

type ShipmentRow = {
  id: string
  number: string
  carrier: string | null
  tracking_ref: string | null
  tracking_url: string | null
  tracking_key: string | null
  tracking_code: string | null
  delivery_date: Date | string | null
  delivery_slot_start: string | null
  delivery_slot_end: string | null
}

function dayText(value: Date | string | null): string | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

async function outstandingLines(tx: TxClient, orderId: string): Promise<Array<{ id: string; qty: string }>> {
  const rows = await tx.$queryRaw<Array<{ id: string; outstanding: unknown }>>`
    SELECT l."id",
           (l."qty" - l."qty_cancelled" - COALESCE((
             SELECT SUM(sl."qty") FROM "po_shipment_lines" sl WHERE sl."order_line_id" = l."id"
           ), 0)) AS "outstanding"
      FROM "po_order_lines" l
     WHERE l."order_id" = ${orderId}
     ORDER BY l."position" ASC, l."created_at" ASC
  `
  return rows
    .map((r) => ({ id: r.id, qty: Number(r.outstanding) }))
    .filter((r) => r.qty > 0)
    .map((r) => ({ id: r.id, qty: r.qty.toFixed(3) }))
}

/** What a later email may change on a despatch already recorded, and the names
 *  of what it changed. A number or a link already there is never overwritten -
 *  a different one is a second parcel, or somebody else's link, not news about
 *  this one - so they only ever fill a blank, and the link's code comes with
 *  the link it belongs to. A day and a slot are the carrier's latest word and
 *  replace what was there. */
function patchFor(existing: ShipmentRow, input: RecordInput): { sets: Prisma.Sql[]; changed: string[] } {
  const sets: Prisma.Sql[] = []
  const changed: string[] = []
  const c = input.candidate
  if (c?.trackingNumber && !existing.tracking_ref) {
    sets.push(Prisma.sql`"tracking_ref" = ${c.trackingNumber}`)
    changed.push('tracking number')
  }
  if (c?.trackingUrl && !existing.tracking_url) {
    sets.push(Prisma.sql`"tracking_url" = ${c.trackingUrl}`)
    changed.push('tracking link')
    if (c.shortCode && !existing.tracking_code) sets.push(Prisma.sql`"tracking_code" = ${c.shortCode}`)
  }
  if (c?.carrier && !existing.carrier) sets.push(Prisma.sql`"carrier" = ${c.carrier}`)
  const key = c ? trackingKeyOf(c) : null
  if (key && !existing.tracking_key) sets.push(Prisma.sql`"tracking_key" = ${key}`)
  if (input.deliveryDate && input.deliveryDate !== dayText(existing.delivery_date)) {
    sets.push(Prisma.sql`"delivery_date" = ${input.deliveryDate}::date`)
    changed.push('delivery day')
  }
  if (input.deliverySlot && (input.deliverySlot[0] !== existing.delivery_slot_start || input.deliverySlot[1] !== existing.delivery_slot_end)) {
    sets.push(Prisma.sql`"delivery_slot_start" = ${input.deliverySlot[0]}, "delivery_slot_end" = ${input.deliverySlot[1]}`)
    changed.push('delivery slot')
  }
  return { sets, changed }
}

/**
 * Put one email's tracking on one order: update the despatch it is news about,
 * or record a new one covering everything still to come.
 *
 * Under a row lock on the order, so two runs about one order take turns; the
 * second finds the first one's despatch and changes nothing.
 */
export async function recordTrackingDespatch(input: RecordInput): Promise<RecordResult> {
  const config = await getPoConfigCached()
  const result = await prisma.$transaction(async (tx): Promise<RecordResult> => {
    const locked = await tx.$queryRaw<Array<{ id: string; number: string }>>`
      SELECT "id", "number" FROM "po_orders" WHERE "id" = ${input.orderId} FOR UPDATE
    `
    const order = locked[0]
    if (!order) return { kind: 'refused', reason: 'That purchase order is not here any more.' }

    const shipments = await tx.$queryRaw<ShipmentRow[]>`
      SELECT "id", "number", "carrier", "tracking_ref", "tracking_url", "tracking_key", "tracking_code",
             "delivery_date", "delivery_slot_start", "delivery_slot_end"
        FROM "po_shipments"
       WHERE "order_id" = ${input.orderId}
       ORDER BY "created_at" ASC
    `
    const found: RecognisedTracking = {
      candidates: input.candidate ? [input.candidate] : [],
      deliveryDate: input.deliveryDate,
      deliverySlot: input.deliverySlot,
      supplierRefs: [],
      looseRefs: [],
      postcodes: [],
      addressPostcodes: [],
    }
    const asDespatches: TrackingDespatch[] = shipments.map((s) => ({
      id: s.id, orderId: input.orderId, trackingKey: s.tracking_key, trackingRef: s.tracking_ref,
      trackingCode: s.tracking_code, trackingUrl: s.tracking_url,
    }))
    const untracked = shipments.filter((s) => !s.tracking_ref && !s.tracking_url && !s.tracking_code)

    // News about a parcel already here, or a day for the order's only parcel,
    // or tracking for the order's only parcel that went out with none.
    const known = despatchFor(input.orderId, found, asDespatches)
    let target = known ? shipments.find((s) => s.id === known.id) ?? null : null
    if (!target && !input.candidate && shipments.length === 1) target = shipments[0]!

    if (!target && !input.candidate) {
      return {
        kind: 'refused',
        reason: shipments.length === 0
          ? `A delivery day for ${order.number}, but nothing has been recorded as despatched on it to put the day on.`
          : `A delivery day for ${order.number}, which has ${shipments.length} despatches, so which one it is for cannot be told.`,
      }
    }

    if (!target) {
      const lines = await outstandingLines(tx, input.orderId)
      if (lines.length === 0) {
        // Everything has gone already, in one parcel. That parcel takes the
        // tracking when it went with none, or when this brings no number of
        // its own to disagree with the one it has - a delivery firm's timeslot
        // email quotes its link and nothing else. Otherwise this is somebody
        // else's tracking and nothing already recorded is overwritten.
        const only = shipments.length === 1 ? shipments[0]! : null
        const noClash = only !== null
          && (untracked.length === 1 || !input.candidate?.trackingNumber || !only.tracking_ref)
        if (only && noClash) target = only
        else {
          return {
            kind: 'refused',
            reason: `Everything on ${order.number} is already recorded as despatched under other tracking, so this has been left alone.`,
          }
        }
      } else {
        const candidate = input.candidate!
        const key = trackingKeyOf(candidate)
        const seq = await tx.$queryRaw<Array<{ nextval: bigint }>>`SELECT nextval('po_shipment_number_seq') AS nextval`
        const number = `${config.shipmentNumberPrefix}${seq[0]!.nextval.toString().padStart(5, '0')}`
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "po_shipments" (
            "number", "order_id", "despatched_date", "carrier", "tracking_ref", "tracking_url", "notes", "source",
            "created_by_user_id", "tracking_key", "tracking_code", "delivery_date", "delivery_slot_start",
            "delivery_slot_end", "source_message_id", "announce_pending", "updated_at"
          ) VALUES (
            ${number}, ${input.orderId}, ${input.sentDay}::date, ${candidate.carrier}, ${candidate.trackingNumber},
            ${candidate.trackingUrl}, ${'From an email carrying the tracking.'}, 'INBOX', ${input.userId}, ${key},
            ${candidate.shortCode}, ${input.deliveryDate}::date, ${input.deliverySlot?.[0] ?? null},
            ${input.deliverySlot?.[1] ?? null}, ${input.messageId}, true, clock_timestamp()
          )
          ON CONFLICT ("order_id", "tracking_key") WHERE "tracking_key" IS NOT NULL DO NOTHING
          RETURNING "id"
        `
        const despatchId = inserted[0]?.id
        if (!despatchId) {
          // Only reachable if the lock above were somehow not held: the index
          // still says one parcel, one despatch.
          return { kind: 'refused', reason: `That parcel is already recorded on ${order.number}.` }
        }
        for (const line of lines) {
          await tx.$executeRaw`
            INSERT INTO "po_shipment_lines" ("shipment_id", "order_line_id", "qty")
            VALUES (${despatchId}, ${line.id}, ${line.qty}::numeric)
          `
        }
        return { kind: 'created', despatchId, number }
      }
    }

    const { sets, changed } = patchFor(target, input)
    if (sets.length === 0) return { kind: 'unchanged', despatchId: target.id, number: target.number }
    await tx.$executeRaw`
      UPDATE "po_shipments"
         SET ${Prisma.join(sets, ', ')}, "announce_pending" = true, "announce_attempts" = 0, "announce_tried_at" = NULL,
             -- The moment of the write, not of the transaction's start: the
             -- announcer clears the pending flag as of the updated_at it read,
             -- and a write that committed after that read must look later than
             -- it even if its transaction began earlier.
             "updated_at" = clock_timestamp()
       WHERE "id" = ${target.id}
    `
    return changed.length > 0
      ? { kind: 'updated', despatchId: target.id, number: target.number, changed }
      : { kind: 'unchanged', despatchId: target.id, number: target.number }
  })

  if (result.kind === 'created' || result.kind === 'updated') {
    await recordAudit(
      'order',
      input.orderId,
      result.kind === 'created' ? 'order.despatch_from_email' : 'order.despatch_updated_from_email',
      {
        note: result.kind === 'created'
          ? `Despatch ${result.number} recorded from an email carrying the tracking.`
          : `Despatch ${result.number}: ${result.changed.join(', ')} from an email.`,
        despatch: result.number,
        message: input.messageId,
        trackingNumber: input.candidate?.trackingNumber ?? null,
        trackingUrl: input.candidate?.trackingUrl ?? null,
        deliveryDate: input.deliveryDate,
        deliverySlot: input.deliverySlot,
      },
      input.userId,
    )
  }
  return result
}

// ---------------------------------------------------------------------------
// Announcing it
// ---------------------------------------------------------------------------

/** What an announcement is ABOUT, as one string. A change to any of these is
 *  news; a change to anything else (a carrier's name filled in) is not. */
function fingerprintOf(row: ShipmentRow): string {
  return JSON.stringify([
    row.tracking_ref, row.tracking_url, row.tracking_code, dayText(row.delivery_date),
    row.delivery_slot_start, row.delivery_slot_end,
  ])
}

/**
 * Tell the observers of `purchase-orders.despatch-recorded`, if there is news.
 *
 * Only for an order going straight to the customer that was raised off one of
 * shop's orders: a despatch to our own warehouse is recorded on the order and
 * is nobody else's business. What was announced is a fingerprint on the
 * despatch, written once the observers have taken it, so an email that changes
 * nothing announces nothing.
 *
 * Never throws: the despatch is recorded whether anybody listens or not.
 */
export async function announceDespatch(
  despatchId: string,
  observers?: readonly DespatchRecordedObserver[],
): Promise<DespatchRecordedEvent | null> {
  try {
    const rows = await prisma.$queryRaw<Array<ShipmentRow & {
      announced: string | null
      order_number: string
      ship_to_kind: string
      source_ref: unknown
      updated_text: string
    }>>`
      SELECT d."id", d."number", d."carrier", d."tracking_ref", d."tracking_url", d."tracking_key", d."tracking_code",
             d."delivery_date", d."delivery_slot_start", d."delivery_slot_end", d."announced",
             d."updated_at"::text AS "updated_text",
             o."number" AS "order_number", o."ship_to_kind", o."source_ref"
        FROM "po_shipments" d
        JOIN "po_orders" o ON o."id" = d."order_id"
       WHERE d."id" = ${despatchId}
    `
    const found = rows[0]
    if (!found) return null
    // The pending flag is cleared only as of the version read here: an email
    // that changed the despatch since sets it again, and is announced in turn.
    // Compared as the database's own text, to the microsecond.
    const settle = (announced: string | null) => prisma.$executeRaw`
      UPDATE "po_shipments"
         SET "announced" = COALESCE(${announced}, "announced"),
             "announce_pending" = ("updated_at" > ${found.updated_text}::timestamptz),
             "announce_attempts" = 0, "announce_tried_at" = NULL
       WHERE "id" = ${despatchId}
    `
    const ref = found.source_ref as { orderId?: unknown } | null
    const orderId = typeof ref?.orderId === 'string' && ref.orderId ? ref.orderId : null
    const fingerprint = fingerprintOf(found)
    // Nobody to tell (our own warehouse, an order not raised off the shop), or
    // nothing new to tell them: settled.
    if (found.ship_to_kind !== 'CUSTOMER' || !orderId || found.announced === fingerprint) {
      await settle(null)
      return null
    }
    const claimed = { row: found, orderId, change: found.announced === null ? ('new' as const) : ('update' as const) }

    const lines = await prisma.$queryRaw<Array<{ source_order_item_id: string; qty: unknown }>>`
      SELECT l."source_order_item_id", sl."qty"
        FROM "po_shipment_lines" sl
        JOIN "po_order_lines" l ON l."id" = sl."order_line_id"
       WHERE sl."shipment_id" = ${despatchId}
         AND l."source_order_item_id" IS NOT NULL
       ORDER BY l."position" ASC
    `
    const { row } = claimed
    const event: DespatchRecordedEvent = {
      despatchId,
      change: claimed.change,
      purchaseOrderNumber: row.order_number,
      source: { module: 'shop', orderId: claimed.orderId },
      lines: lines
        .map((l) => ({ sourceOrderItemId: l.source_order_item_id, qty: Math.round(Number(l.qty)) }))
        .filter((l) => l.qty > 0),
      carrier: row.carrier,
      trackingNumber: row.tracking_ref,
      trackingUrl: row.tracking_url,
      trackingShortCode: row.tracking_code,
      deliveryDate: dayText(row.delivery_date),
      deliverySlot: row.delivery_slot_start && row.delivery_slot_end ? [row.delivery_slot_start, row.delivery_slot_end] : null,
    }
    if (event.lines.length === 0) {
      await settle(null)
      return null
    }
    // Marked announced only once every observer has taken it without
    // throwing. An observer throws for a passing failure (a busy order, a
    // database blip) and returns quietly for a permanent refusal; a throw
    // leaves the despatch pending, and announcePendingDespatches tries again.
    // Two runs reading the same email at once may both announce it; the
    // observers are idempotent for exactly that reason (shop finds the
    // tracking already on the order and does nothing).
    const delivered = await notifyDespatchRecorded(event, observers)
    if (delivered) await settle(fingerprint)
    else await failedToAnnounce(despatchId)
    return event
  } catch (error) {
    console.error('[purchase-orders] could not announce a despatch', despatchId, error)
    await failedToAnnounce(despatchId).catch(() => {})
    return null
  }
}

/** Tries before a despatch stops being announced by the job and waits for a
 *  person. A listener that has failed ten times, half an hour and more apart,
 *  is not failing for a moment. */
export const MAX_ANNOUNCE_ATTEMPTS = 10

/**
 * Count a failed announcement, and on the last allowed one put it on the
 * Paperwork list (and so in the problem report) with a sentence: the parcel is
 * on the purchase order but not on the customer's order, and a person has to
 * put it there. One row per despatch, however often it gives up.
 */
async function failedToAnnounce(despatchId: string): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ attempts: number; number: string; order_id: string; order_number: string }>>`
    UPDATE "po_shipments" d
       SET "announce_attempts" = d."announce_attempts" + 1, "announce_tried_at" = clock_timestamp()
      FROM "po_orders" o
     WHERE d."id" = ${despatchId} AND o."id" = d."order_id" AND d."announce_pending"
    RETURNING d."announce_attempts" AS "attempts", d."number", d."order_id", o."number" AS "order_number"
  `
  const row = rows[0]
  if (!row || Number(row.attempts) < MAX_ANNOUNCE_ATTEMPTS) return
  await prisma.$executeRaw`
    INSERT INTO "po_inbound_documents" (
      "message_id", "attachment_id", "filename", "page_from", "kind", "order_id", "shipment_id", "outcome", "reason", "handled_at"
    ) VALUES (
      ${`despatch:${despatchId}`}, ${`announce:${despatchId}`}, ${'Delivery tracking not passed on'}, 0, 'announce',
      ${row.order_id}, ${despatchId}, 'NEEDS_EYES',
      ${`Despatch ${row.number} on ${row.order_number} could not be put on the customer's order after ${MAX_ANNOUNCE_ATTEMPTS} tries, so it has stopped trying. Record the parcel on the customer's order by hand, then press "Ignore it".`},
      now()
    )
    ON CONFLICT ("attachment_id", "page_from") DO NOTHING
  `
}

/**
 * Announce whatever is still pending - a despatch an email changed whose
 * listeners failed for the moment. Run from the half-hourly inbound-documents
 * job. One indexed read when nothing is waiting, which is nearly always; at
 * most `limit` despatches a run, longest since tried first, and nothing
 * started past `deadline`. Each failure waits longer before the next try
 * (half an hour per failure so far, capped at four hours), so one that keeps
 * failing cannot starve the rest; after MAX_ANNOUNCE_ATTEMPTS it is left to a
 * person. Returns how many were tried.
 */
export async function announcePendingDespatches(options: {
  deadline: number
  limit?: number
  observers?: readonly DespatchRecordedObserver[]
}): Promise<number> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)))
  const pending = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "po_shipments"
     WHERE "announce_pending"
       AND "announce_attempts" < ${MAX_ANNOUNCE_ATTEMPTS}
       AND ("announce_tried_at" IS NULL
            OR "announce_tried_at" < now() - interval '30 minutes' * LEAST("announce_attempts", 8))
     ORDER BY "announce_tried_at" ASC NULLS FIRST, "updated_at" ASC
     LIMIT ${limit}
  `
  let tried = 0
  for (const { id } of pending) {
    if (Date.now() >= options.deadline) break
    await announceDespatch(id, options.observers)
    tried++
  }
  return tried
}

// ---------------------------------------------------------------------------
// One email, start to finish
// ---------------------------------------------------------------------------

export type TrackingMessage = {
  messageId: string
  threadId: string
  fromAddress: string
  recipients: string[]
  subject: string
  bodyText: string
  sentAt: string
}

export type TrackingOutcome = {
  match: TrackingMatch | null
  recorded: RecordResult | null
  note: string | null
  orderId: string | null
  orderNumber: string | null
}

function noteFor(match: TrackingMatch, recorded: RecordResult | null): string | null {
  if (match.kind === 'propose') {
    return `Delivery tracking that may be for ${match.order.number} is on the Paperwork list in Purchasing`
  }
  if (match.kind !== 'apply' || !recorded) return null
  switch (recorded.kind) {
    case 'created':
      return `Tracking recorded on ${match.order.number} as despatch ${recorded.number}`
    case 'updated':
    case 'unchanged':
      return `Delivery news for ${match.order.number}, on despatch ${recorded.number}`
    default:
      return null
  }
}

async function saveRow(
  message: TrackingMessage,
  supplierIds: readonly string[],
  outcome: 'FILED' | 'NEEDS_EYES' | 'IGNORED',
  detail: TrackingDetail,
  orderId: string | null,
  shipmentId: string | null,
  reason: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "po_inbound_documents" (
      "message_id", "thread_id", "attachment_id", "filename", "subject", "from_address", "received_at",
      "supplier_ids", "page_from", "kind", "supplier_ref", "order_id", "filed_as", "shipment_id",
      "tracking", "outcome", "reason", "handled_at"
    ) VALUES (
      ${message.messageId}, ${message.threadId}, ${trackingRowKey(message.messageId)}, ${'Delivery tracking'},
      ${message.subject.slice(0, 500)}, ${message.fromAddress}, ${message.sentAt}::timestamptz,
      ${[...supplierIds]}::text[], 0, 'tracking', ${detail.candidate?.trackingNumber ?? null}, ${orderId},
      ${outcome === 'FILED' ? 'despatch' : null}, ${shipmentId}, ${JSON.stringify(detail)}::jsonb,
      ${outcome}, ${reason}, now()
    )
    ON CONFLICT ("attachment_id", "page_from") DO NOTHING
  `
}

/**
 * Read one email for tracking and act on it: record (rules 1-3), propose (any
 * rule, where matchTracking says a person should look), or leave it. Returns
 * what the conversation should be told.
 *
 * `observers` is for the tests; left out, the installed ones are gathered.
 */
export async function handleTrackingMessage(
  message: TrackingMessage,
  suppliers: readonly SenderSupplier[] | (() => Promise<readonly SenderSupplier[]>),
  options: { timezone?: string; observers?: readonly DespatchRecordedObserver[]; extraLinkHosts?: readonly string[] } = {},
): Promise<TrackingOutcome> {
  const none: TrackingOutcome = { match: null, recorded: null, note: null, orderId: null, orderNumber: null }
  const timezone = options.timezone ?? (await getSiteTimezone())
  const sentDay = calendarDateIn(message.sentAt, timezone) || calendarDateIn(new Date(), timezone)
  const read = recogniseTracking({ subject: message.subject, bodyText: message.bodyText, today: sentDay })
  if (read.candidates.length === 0 && !read.deliveryDate && !read.deliverySlot) return none

  // The supplier list only now: nearly every email stops above.
  const sender = senderKind(message.fromAddress, message.recipients, typeof suppliers === 'function' ? await suppliers() : suppliers)
  if (sender.kind === 'internal') return none

  // Anybody who is not the supplier is believed about a link only where it goes
  // to a known carrier, a host the owner has listed, or their own domain.
  // Otherwise the link (its code and its postcode with it) is left out and the
  // number kept: anybody on the internet can write an email with a "tracking"
  // link to a page of their own, and this one would reach a customer.
  const extraHosts = options.extraLinkHosts ?? trackingLinkHostList((await getPoConfigCached()).trackingLinkHosts)
  const { found, linkDropped } = sender.kind === 'supplier'
    ? { found: read, linkDropped: false }
    : believedLinks(read, message.fromAddress, extraHosts)
  if (sender.kind === 'other' && found.candidates.length === 0) return none

  const [orders, despatches] = await Promise.all([trackingOrders(), trackedDespatches()])
  const text = [message.subject, ...ownLines(message.bodyText)].join('\n')
  const match = matchTracking({ sender: sender.kind, supplierIds: sender.supplierIds, text, found, orders, despatches, linkDropped })

  let candidate = found.candidates[0] ?? null
  if (candidate && !candidate.carrier && sender.kind === 'other') {
    candidate = { ...candidate, carrier: carrierFromSender(message.fromAddress) }
  }
  const detail: TrackingDetail = {
    candidate,
    deliveryDate: found.deliveryDate,
    deliverySlot: found.deliverySlot,
    supplierRefs: found.supplierRefs,
    postcodes: found.postcodes,
    sentDay,
    rule: match.kind === 'ignore' ? null : match.rule,
    note: null,
  }

  if (match.kind === 'ignore') {
    // A row only where there was tracking to speak of: an email that merely
    // mentioned a day is not worth keeping a record of not using.
    if (candidate) await saveRow(message, sender.supplierIds, 'IGNORED', detail, null, null, match.reason)
    return { ...none, match }
  }

  if (match.kind === 'propose') {
    const note = noteFor(match, null)
    await saveRow(message, sender.supplierIds, 'NEEDS_EYES', { ...detail, note }, match.order.id, null, match.reason)
    return { match, recorded: null, note, orderId: match.order.id, orderNumber: match.order.number }
  }

  const recorded = await recordTrackingDespatch({
    orderId: match.order.id,
    candidate,
    deliveryDate: found.deliveryDate,
    deliverySlot: found.deliverySlot,
    sentDay,
    messageId: message.messageId,
    userId: null,
  })
  if (recorded.kind === 'refused') {
    if (candidate) await saveRow(message, sender.supplierIds, 'IGNORED', detail, match.order.id, null, recorded.reason)
    return { match, recorded, note: null, orderId: match.order.id, orderNumber: match.order.number }
  }
  const note = noteFor(match, recorded)
  await saveRow(message, sender.supplierIds, 'FILED', { ...detail, note }, match.order.id, recorded.despatchId, null)
  await announceDespatch(recorded.despatchId, options.observers)
  return { match, recorded, note, orderId: match.order.id, orderNumber: match.order.number }
}

// ---------------------------------------------------------------------------
// A person's "yes, that one" on the Paperwork list
// ---------------------------------------------------------------------------

/**
 * Record a proposal a person has looked at and agreed with. The claim first,
 * so two people pressing at once record it once; then exactly the code a rule
 * 1-3 match runs.
 */
export async function applyTrackingProposal(
  id: string,
  userId: string,
  observers?: readonly DespatchRecordedObserver[],
): Promise<{ ok: true; orderNumber: string } | { ok: false; reason: string }> {
  const claimed = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "po_inbound_documents"
       SET "claimed_at" = now()
     WHERE "id" = ${id} AND "outcome" = 'NEEDS_EYES' AND "kind" = 'tracking'
       AND ("claimed_at" IS NULL OR "claimed_at" < now() - interval '10 minutes')
    RETURNING "order_id", "message_id", "tracking"
  `
  const row = claimed[0]
  if (!row) return { ok: false, reason: 'Somebody has already dealt with that one.' }
  try {
    const orderId = row.order_id as string | null
    const detail = row.tracking as TrackingDetail | null
    if (!orderId || !detail) return { ok: false, reason: 'That purchase order is not here any more.' }
    const status = await prisma.$queryRaw<Array<{ number: string; status: PoStatus }>>`
      SELECT "number", "status" FROM "po_orders" WHERE "id" = ${orderId}
    `
    const order = status[0]
    if (!order) return { ok: false, reason: 'That purchase order is not here any more.' }
    if (!DESPATCH_STATES.includes(order.status)) {
      return { ok: false, reason: `${order.number} is not expecting a delivery any more, so nothing has been recorded.` }
    }
    const recorded = await recordTrackingDespatch({
      orderId,
      candidate: detail.candidate,
      deliveryDate: detail.deliveryDate,
      deliverySlot: detail.deliverySlot,
      sentDay: detail.sentDay,
      messageId: row.message_id as string,
      userId,
    })
    if (recorded.kind === 'refused') return { ok: false, reason: recorded.reason }
    const note = `Tracking recorded on ${order.number} as despatch ${recorded.number}`
    await prisma.$executeRaw`
      UPDATE "po_inbound_documents"
         SET "outcome" = 'FILED', "filed_as" = 'despatch', "shipment_id" = ${recorded.despatchId},
             "tracking" = ${JSON.stringify({ ...detail, note })}::jsonb,
             "handled_by_user_id" = ${userId}, "handled_at" = now(), "reason" = NULL
       WHERE "id" = ${id}
    `
    await announceDespatch(recorded.despatchId, observers)
    return { ok: true, orderNumber: order.number }
  } finally {
    await prisma.$executeRaw`UPDATE "po_inbound_documents" SET "claimed_at" = NULL WHERE "id" = ${id}`.catch(() => {})
  }
}
