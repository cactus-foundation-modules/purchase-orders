import { prisma } from '@/lib/db/prisma'
import { downloadMedia } from '@/lib/media/upload'

// The proforma dance, and the paperwork that comes back with it.
//
// A supplier on proforma terms invoices BEFORE they will confirm anything. So an
// order to one of them has three states worth telling apart: waiting for their
// proforma, waiting for us to pay it, and paid - after which they acknowledge
// the order in the ordinary way and attach their acknowledgement to it.
//
// Every write here is narrow and guarded in SQL rather than read-then-write, for
// the same reason the portal's acknowledgement is: two people can press a button
// at the same moment, and one of the two is often not in this building.

/** The supplier's proforma, filed against the order. `mediaId` is a plain Media
 *  id and never a foreign key - core owns that table. */
export async function setProformaDocument(
  orderId: string,
  mediaId: string,
  ref: string | null,
  amount: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "proforma_media_id" = ${mediaId},
           "proforma_ref" = COALESCE(NULLIF(${ref ?? ''}, ''), "proforma_ref"),
           "proforma_amount" = COALESCE(${amount}::numeric, "proforma_amount"),
           "proforma_received_at" = now(),
           "updated_at" = now()
     WHERE "id" = ${orderId}
  `
}

/**
 * We have paid it.
 *
 * The guard is the WHERE clause: an order already marked paid keeps the stamp it
 * has and the name against it, so a second press cannot quietly re-date somebody
 * else's payment. Returns false when it was already paid, which the caller says
 * out loud rather than pretending it did something.
 */
export async function markProformaPaid(
  orderId: string,
  paymentRef: string | null,
  userId: string,
): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "proforma_paid_at" = now(),
           "proforma_paid_by_user_id" = ${userId},
           "proforma_payment_ref" = ${paymentRef},
           "updated_at" = now()
     WHERE "id" = ${orderId} AND "proforma_paid_at" IS NULL
  `
  return count > 0
}

/**
 * Their proforma number, typed in or corrected by hand.
 *
 * A flat write rather than the COALESCE the document upload does, and that is
 * the whole point of it existing separately: an upload must never clear a
 * reference somebody already typed, and an edit must be able to - including
 * back to nothing, when what got filled in was wrong.
 */
export async function setProformaReference(orderId: string, ref: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders" SET "proforma_ref" = ${ref}, "updated_at" = now() WHERE "id" = ${orderId}
  `
}

/** What their proforma is for, where it differs from the order's own total -
 *  carriage they have added, or a part shipment they will invoice twice for. */
export async function setProformaAmount(orderId: string, amount: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "proforma_amount" = ${amount}::numeric, "updated_at" = now()
     WHERE "id" = ${orderId}
  `
}

/** Their sales order number off the acknowledgement, typed in or corrected. */
export async function setAcknowledgementReference(orderId: string, ref: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders" SET "ack_ref" = ${ref}, "updated_at" = now() WHERE "id" = ${orderId}
  `
}

/**
 * The proof that the money left: a screenshot of the payment, or a remittance.
 *
 * Filed against the order rather than emailed straight out and forgotten,
 * because the question asked six weeks later is "what did we send them", and the
 * answer needs to be somewhere other than one person's sent items.
 */
export async function setPaymentProofDocument(orderId: string, mediaId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "proforma_payment_proof_media_id" = ${mediaId}, "updated_at" = now()
     WHERE "id" = ${orderId}
  `
}

/** Stamped when the proof actually travelled to the supplier, which is a
 *  different fact from the payment being recorded here. */
export async function markProofSent(orderId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "proforma_proof_sent_at" = now(), "updated_at" = now()
     WHERE "id" = ${orderId}
  `
}

/** Somebody pressed it by mistake. The document itself stays where it is - only
 *  the payment is taken back. */
export async function clearProformaPayment(orderId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "proforma_paid_at" = NULL, "proforma_paid_by_user_id" = NULL, "proforma_payment_ref" = NULL,
           "proforma_proof_sent_at" = NULL, "updated_at" = now()
     WHERE "id" = ${orderId}
  `
}

/** Whether this order waits for a proforma at all, and how far along it is.
 *  One query, because the portal asks on every page load. */
export async function proformaStatus(orderId: string): Promise<{
  required: boolean
  received: boolean
  paid: boolean
} | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "proforma_required", "proforma_media_id", "proforma_received_at", "proforma_paid_at"
      FROM "po_orders" WHERE "id" = ${orderId} LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return {
    required: Boolean(r.proforma_required),
    received: Boolean(r.proforma_media_id) || Boolean(r.proforma_received_at),
    paid: Boolean(r.proforma_paid_at),
  }
}

/** Turns the proforma requirement on or off for one order, without touching the
 *  supplier. For the order that is the exception - a one-off from a supplier on
 *  account, or an account supplier who has asked for money up front this once. */
export async function setProformaRequired(orderId: string, required: boolean): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders" SET "proforma_required" = ${required}, "updated_at" = now() WHERE "id" = ${orderId}
  `
}

/** The supplier's order acknowledgement, filed when they confirmed. Written by
 *  the portal alongside the acknowledgement itself, so the two land together or
 *  not at all. */
export async function setAcknowledgementDocument(
  orderId: string,
  mediaId: string,
  ref: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "ack_media_id" = ${mediaId},
           "ack_ref" = COALESCE(NULLIF(${ref ?? ''}, ''), "ack_ref"),
           "updated_at" = now()
     WHERE "id" = ${orderId}
  `
}

/**
 * One filed document as BYTES, for hanging on an email.
 *
 * Core's `downloadMedia` reaches into whichever provider the site uses, which is
 * the only way that works everywhere: a signed private bucket has no URL this
 * server can simply fetch, and the one on the Media row may be a CDN address
 * that answers a browser and nothing else.
 *
 * Never throws. A proof that cannot be fetched is an email sent without it,
 * which is what happened before there was one at all.
 */
export async function mediaAttachment(
  mediaId: string | null,
): Promise<{ filename: string; content: Buffer; contentType: string } | null> {
  if (!mediaId) return null
  const row = await prisma.media
    .findUnique({
      where: { id: mediaId },
      select: { key: true, url: true, provider: true, mimeType: true, originalName: true },
    })
    .catch(() => null)
  if (!row) return null
  try {
    const content = await downloadMedia(row.provider, row.key, row.url)
    return {
      filename: row.originalName || `payment-proof.${row.mimeType.split('/')[1] ?? 'pdf'}`,
      content,
      contentType: row.mimeType,
    }
  } catch (error) {
    console.error('[purchase-orders] could not fetch media', mediaId, 'to attach', error)
    return null
  }
}

/** The public URL of a file this module has filed, for a link on a screen. Null
 *  where the id points at nothing, which is what a media row deleted underneath
 *  us looks like. */
export async function mediaLink(
  mediaId: string | null,
): Promise<{ url: string; originalName: string | null; mimeType: string | null } | null> {
  if (!mediaId) return null
  const row = await prisma.media
    .findUnique({ where: { id: mediaId }, select: { url: true, originalName: true, mimeType: true } })
    .catch(() => null)
  return row ? { url: row.url, originalName: row.originalName ?? null, mimeType: row.mimeType } : null
}

/** One filed document, as a screen needs it. */
export type PoDocumentLink = { url: string; originalName: string | null; mimeType: string | null }

/** The three files that can hang off an order: the two the supplier sends, and
 *  the proof of payment that goes the other way. */
export type PoOrderDocuments = {
  proforma: PoDocumentLink | null
  acknowledgement: PoDocumentLink | null
  paymentProof: PoDocumentLink | null
}

/** Resolved in one place so the order's own GET and the upload that changed it
 *  cannot word the same payload two different ways. */
export async function orderDocuments(order: {
  proformaMediaId: string | null
  ackMediaId: string | null
  proformaPaymentProofMediaId: string | null
} | null): Promise<PoOrderDocuments> {
  const [proforma, acknowledgement, paymentProof] = await Promise.all([
    mediaLink(order?.proformaMediaId ?? null),
    mediaLink(order?.ackMediaId ?? null),
    mediaLink(order?.proformaPaymentProofMediaId ?? null),
  ])
  return { proforma, acknowledgement, paymentProof }
}
