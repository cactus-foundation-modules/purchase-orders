import { prisma } from '@/lib/db/prisma'

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

/** Somebody pressed it by mistake. The document itself stays where it is - only
 *  the payment is taken back. */
export async function clearProformaPayment(orderId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "proforma_paid_at" = NULL, "proforma_paid_by_user_id" = NULL, "proforma_payment_ref" = NULL,
           "updated_at" = now()
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
