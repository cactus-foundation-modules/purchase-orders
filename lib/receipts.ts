import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type {
  PoAwaitingOrder,
  PoReceipt,
  PoReceiptLine,
  PoReceiptSummary,
  PoStatus,
  PoStockResult,
} from './types'

// Deliveries. Raw SQL like the rest of the module, and for the same reason: the
// po_ tables are not in the generated Prisma client.
//
// A receipt is the record of what physically turned up. It carries no money at
// all - the price is the order's business and the bill's, and a delivery note
// that disagreed with both would only ever be a third opinion.

/** The states an order can still take a delivery in. */
const RECEIVABLE_STATUSES: PoStatus[] = ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'RECEIVED', 'ON_HOLD']

function dec(value: unknown): string {
  if (value === null || value === undefined) return '0'
  return String(value)
}

function day(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

function stamp(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function mapSummary(r: Record<string, unknown>): PoReceiptSummary {
  return {
    id: r.id as string,
    number: r.number as string,
    orderId: r.order_id as string,
    orderNumber: (r.order_number as string | null) ?? '',
    supplierName: (r.supplier_name as string | null) ?? '',
    receivedDate: day(r.received_date) ?? '',
    deliveryNoteRef: (r.delivery_note_ref as string | null) ?? null,
    carrier: (r.carrier as string | null) ?? null,
    receivedByUserId: (r.received_by_user_id as string | null) ?? null,
    receivedByName: (r.received_by_name as string | null) ?? null,
    stockApplied: Boolean(r.stock_applied),
    lineCount: Number(r.line_count ?? 0),
    createdAt: stamp(r.created_at) ?? '',
  }
}

function mapLine(r: Record<string, unknown>): PoReceiptLine {
  return {
    id: r.id as string,
    orderLineId: r.order_line_id as string,
    qtyAccepted: dec(r.qty_accepted),
    qtyRejected: dec(r.qty_rejected),
    rejectReason: (r.reject_reason as string | null) ?? null,
    conditionNote: (r.condition_note as string | null) ?? null,
    description: (r.description as string | null) ?? '',
    supplierSku: (r.supplier_sku as string | null) ?? null,
    productId: (r.product_id as string | null) ?? null,
    unit: (r.unit as string | null) ?? 'each',
  }
}

const SUMMARY_SELECT = Prisma.sql`
  r."id", r."number", r."order_id", r."received_date", r."delivery_note_ref", r."carrier",
  r."received_by_user_id", r."stock_applied", r."created_at",
  o."number" AS "order_number", s."name" AS "supplier_name",
  COALESCE(u."displayName", u."username") AS "received_by_name",
  (SELECT count(*) FROM "po_receipt_lines" rl WHERE rl."receipt_id" = r."id") AS "line_count"
`

const SUMMARY_FROM = Prisma.sql`
  FROM "po_receipts" r
  JOIN "po_orders" o ON o."id" = r."order_id"
  JOIN "po_suppliers" s ON s."id" = o."supplier_id"
  LEFT JOIN "User" u ON u."id" = r."received_by_user_id"
`

/** Every delivery booked in against one order, newest first. */
export async function listReceiptsForOrder(orderId: string): Promise<PoReceiptSummary[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM}
     WHERE r."order_id" = ${orderId}
     ORDER BY r."received_date" DESC, r."created_at" DESC
  `
  return rows.map(mapSummary)
}

/** The recent deliveries across every order, for the Receiving tab. */
export async function listReceipts(limit = 50, search = ''): Promise<PoReceiptSummary[]> {
  const term = search.trim()
  const where = term
    ? Prisma.sql`WHERE (r."number" ILIKE ${`%${term}%`} OR o."number" ILIKE ${`%${term}%`}
        OR s."name" ILIKE ${`%${term}%`} OR r."delivery_note_ref" ILIKE ${`%${term}%`})`
    : Prisma.empty
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM}
     ${where}
     ORDER BY r."received_date" DESC, r."created_at" DESC
     LIMIT ${Prisma.raw(String(Math.max(1, Math.min(200, Math.trunc(limit)))))}
  `
  return rows.map(mapSummary)
}

export async function getReceipt(id: string): Promise<PoReceipt | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT}, r."notes", r."stock_applied_at", r."stock_result"
      ${SUMMARY_FROM}
     WHERE r."id" = ${id}
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null

  // The description, code and product come off the ORDER line rather than being
  // copied onto the receipt: a delivery note is a count against an order, and
  // duplicating the wording here would only give the two a chance to disagree.
  const lineRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT rl.*, l."description", l."supplier_sku", l."product_id", l."unit"
      FROM "po_receipt_lines" rl
      JOIN "po_order_lines" l ON l."id" = rl."order_line_id"
     WHERE rl."receipt_id" = ${id}
     ORDER BY l."position" ASC, l."created_at" ASC
  `

  return {
    ...mapSummary(r),
    notes: (r.notes as string | null) ?? null,
    stockAppliedAt: stamp(r.stock_applied_at),
    stockResult: ((r.stock_result as PoStockResult | null) ?? {}) as PoStockResult,
    lines: lineRows.map(mapLine),
  }
}

export type ReceiptLineInput = {
  orderLineId: string
  qtyAccepted: string
  qtyRejected: string
  rejectReason: string | null
  conditionNote: string | null
}

export type ReceiptInput = {
  orderId: string
  receivedDate: string
  deliveryNoteRef: string | null
  carrier: string | null
  notes: string | null
  lines: ReceiptLineInput[]
}

export async function createReceipt(
  number: string,
  input: ReceiptInput,
  userId: string,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "po_receipts" (
        "number", "order_id", "received_date", "delivery_note_ref", "carrier", "notes", "received_by_user_id"
      ) VALUES (
        ${number}, ${input.orderId}, ${input.receivedDate}::date, ${input.deliveryNoteRef},
        ${input.carrier}, ${input.notes}, ${userId}
      )
      RETURNING "id"
    `
    const receiptId = rows[0]!.id
    for (const line of input.lines) {
      await tx.$executeRaw`
        INSERT INTO "po_receipt_lines" (
          "receipt_id", "order_line_id", "qty_accepted", "qty_rejected", "reject_reason", "condition_note"
        ) VALUES (
          ${receiptId}, ${line.orderLineId}, ${line.qtyAccepted}::numeric, ${line.qtyRejected}::numeric,
          ${line.rejectReason}, ${line.conditionNote}
        )
      `
    }
    return receiptId
  })
}

export async function deleteReceipt(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "po_receipts" WHERE "id" = ${id}`
}

/**
 * Marks a delivery's stock as applied, and refuses to do it twice.
 *
 * The guard is the WHERE clause, not a read followed by a write: two people
 * pressing "add to stock" at the same moment would both pass a check done in
 * JavaScript, and the shelf would gain the delivery twice. Returns false when
 * somebody else got there first, and the caller then knows not to move anything.
 */
export async function claimStockApplication(id: string): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "po_receipts"
       SET "stock_applied" = true, "stock_applied_at" = now()
     WHERE "id" = ${id} AND "stock_applied" = false
  `
  return updated > 0
}

/** Hands the claim back when the move could not be made after all. */
export async function releaseStockApplication(id: string, result: PoStockResult): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_receipts"
       SET "stock_applied" = false, "stock_applied_at" = NULL,
           "stock_result" = ${JSON.stringify(result)}::jsonb
     WHERE "id" = ${id}
  `
}

export async function recordStockResult(id: string, result: PoStockResult): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_receipts" SET "stock_result" = ${JSON.stringify(result)}::jsonb WHERE "id" = ${id}
  `
}

/** Whether this order has ever been acknowledged, for the status recompute. */
export async function orderAcknowledged(orderId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ acknowledged_at: Date | null }[]>`
    SELECT "acknowledged_at" FROM "po_orders" WHERE "id" = ${orderId} LIMIT 1
  `
  return Boolean(rows[0]?.acknowledged_at)
}

/**
 * The orders with something still to come.
 *
 * "Still to come" is judged off the lines, not off the status: an order whose
 * every line has arrived is not on this list even if nobody has got round to
 * closing it, and one marked received that later had a delivery deleted is back
 * on it. The status is what the screen shows; the lines are what it counts.
 */
export async function listOrdersAwaitingDelivery(search = ''): Promise<PoAwaitingOrder[]> {
  const term = search.trim()
  const filter = term
    ? Prisma.sql`AND (o."number" ILIKE ${`%${term}%`} OR s."name" ILIKE ${`%${term}%`})`
    : Prisma.empty

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."id", o."number", o."status", o."expected_date", o."required_by_date",
           s."name" AS "supplier_name",
           (SELECT count(*) FROM "po_receipts" r WHERE r."order_id" = o."id") AS "receipt_count",
           (
             SELECT count(*) FROM "po_order_lines" l
              WHERE l."order_id" = o."id"
                AND (l."qty" - l."qty_cancelled") > COALESCE((
                  SELECT SUM(rl."qty_accepted") FROM "po_receipt_lines" rl WHERE rl."order_line_id" = l."id"
                ), 0)
           ) AS "outstanding_lines"
      FROM "po_orders" o
      JOIN "po_suppliers" s ON s."id" = o."supplier_id"
     WHERE o."status" = ANY(${RECEIVABLE_STATUSES}::text[])
     ${filter}
     ORDER BY o."expected_date" ASC NULLS LAST, o."created_at" ASC
     LIMIT 200
  `

  return rows
    .map((r) => ({
      id: r.id as string,
      number: r.number as string,
      status: r.status as PoStatus,
      supplierName: (r.supplier_name as string | null) ?? '',
      expectedDate: day(r.expected_date),
      requiredByDate: day(r.required_by_date),
      outstandingLines: Number(r.outstanding_lines ?? 0),
      receiptCount: Number(r.receipt_count ?? 0),
    }))
    .filter((o) => o.outstandingLines > 0)
}
