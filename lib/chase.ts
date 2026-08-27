import { prisma } from '@/lib/db/prisma'
import type { ChaseFact } from './chasing'
import type { PoStatus } from './types'

// The reads behind chasing. The decision itself is in lib/chasing.ts, which
// knows nothing about a database, so the nightly job and the button on the
// Reports tab cannot come to different conclusions about who is late.

/** Statuses worth even looking at. The narrowing to what is genuinely chaseable
 *  happens in lib/chasing.ts; this is only here to keep the query small. */
const OUT_WITH_SUPPLIER: PoStatus[] = ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED']

function stamp(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function day(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

/**
 * Every order that is out with a supplier, with the supplier's address, how much
 * of it is still owing, and when it was last chased.
 *
 * "Still owing" is counted from the LINES, not from the status - the same rule
 * the receiving screen's list runs on. An order nobody remembered to close is
 * off this list once everything has arrived, and one that had a delivery deleted
 * is back on it.
 *
 * The last-chased date comes out of the audit log rather than a column. There is
 * no `last_chased_at` on `po_orders` and adding one would have meant a migration
 * for a fact the log already holds - and the log is where anybody would look for
 * it anyway.
 */
export async function gatherChaseFacts(): Promise<ChaseFact[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."id", o."number", o."status", o."supplier_id", o."sent_at",
           o."expected_date", o."required_by_date",
           s."name" AS "supplier_name", s."email", s."email_cc",
           (
             SELECT count(*) FROM "po_order_lines" l
              WHERE l."order_id" = o."id"
                AND (l."qty" - l."qty_cancelled") > COALESCE((
                  SELECT SUM(rl."qty_accepted") FROM "po_receipt_lines" rl
                   WHERE rl."order_line_id" = l."id"
                ), 0)
           ) AS "outstanding_lines",
           (
             SELECT MAX(a."created_at") FROM "po_audit_log" a
              WHERE a."entity_type" = 'order' AND a."entity_id" = o."id" AND a."action" = 'order.chased'
           ) AS "last_chased_at"
      FROM "po_orders" o
      JOIN "po_suppliers" s ON s."id" = o."supplier_id"
     WHERE o."status" = ANY(${OUT_WITH_SUPPLIER}::text[])
       AND o."sent_at" IS NOT NULL
     ORDER BY o."number" ASC
  `

  return rows.map((r) => ({
    orderId: r.id as string,
    orderNumber: r.number as string,
    status: r.status as PoStatus,
    supplierId: r.supplier_id as string,
    supplierName: r.supplier_name as string,
    supplierEmail: (r.email as string | null) ?? null,
    supplierEmailCc: (r.email_cc as string | null) ?? null,
    sentAt: stamp(r.sent_at),
    expectedDate: day(r.expected_date),
    requiredByDate: day(r.required_by_date),
    lastChasedAt: stamp(r.last_chased_at),
    outstandingLines: Number(r.outstanding_lines ?? 0),
  }))
}

/** One line of an order that has not fully arrived, as the chase email lists it. */
export type ChaseOutstandingLine = {
  description: string
  supplierSku: string | null
  unit: string
  /** Ordered, less anything cancelled, less what has been booked in. */
  qtyOutstanding: string
}

/**
 * What is actually still owed on one order.
 *
 * Read only for the orders about to be chased rather than for every open one:
 * an email saying "three lines are outstanding" is a good deal less use to a
 * supplier's sales desk than one naming them, and a nightly job that reads every
 * line of every open order to write nothing is a job doing the work twice.
 */
export async function outstandingLinesFor(orderId: string): Promise<ChaseOutstandingLine[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT l."description", l."supplier_sku", l."unit",
           (l."qty" - l."qty_cancelled" - COALESCE((
             SELECT SUM(rl."qty_accepted") FROM "po_receipt_lines" rl WHERE rl."order_line_id" = l."id"
           ), 0)) AS "outstanding"
      FROM "po_order_lines" l
     WHERE l."order_id" = ${orderId}
     ORDER BY l."position" ASC, l."created_at" ASC
  `
  return rows
    .filter((r) => Number(r.outstanding ?? 0) > 0)
    .map((r) => ({
      description: r.description as string,
      supplierSku: (r.supplier_sku as string | null) ?? null,
      unit: (r.unit as string | null) ?? 'each',
      qtyOutstanding: String(r.outstanding ?? '0'),
    }))
}
