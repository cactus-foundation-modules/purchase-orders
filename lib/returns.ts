import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { LINE_PROGRESS_SQL } from './progress'
import type {
  PoReturn,
  PoReturnLine,
  PoReturnStatus,
  PoReturnSummary,
  PoReturnableLine,
  PoStockResult,
} from './types'

// Returns and debit notes. Raw SQL like the rest of the module, because the po_
// tables are not in the generated Prisma client.
//
// A return is a claim: these goods have gone back, and this much money is owed
// for them. It carries its own copy of the unit cost rather than reading the
// order line at print time, because a line amended after the goods went back
// must not silently re-price a credit claim the supplier is already holding.

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

function mapSummary(r: Record<string, unknown>): PoReturnSummary {
  return {
    id: r.id as string,
    number: r.number as string,
    orderId: r.order_id as string,
    orderNumber: (r.order_number as string | null) ?? '',
    supplierId: r.supplier_id as string,
    supplierName: (r.supplier_name as string | null) ?? '',
    status: r.status as PoReturnStatus,
    reason: (r.reason as string | null) ?? null,
    raisedDate: day(r.raised_date),
    sentAt: stamp(r.sent_at),
    currency: (r.currency as string | null) ?? 'GBP',
    creditExpected: dec(r.credit_expected),
    creditReceived: dec(r.credit_received),
    creditRef: (r.credit_ref as string | null) ?? null,
    stockApplied: Boolean(r.stock_applied),
    lineCount: Number(r.line_count ?? 0),
    createdByUserId: (r.created_by_user_id as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: stamp(r.created_at) ?? '',
  }
}

function mapLine(r: Record<string, unknown>): PoReturnLine {
  return {
    id: r.id as string,
    orderLineId: r.order_line_id as string,
    receiptLineId: (r.receipt_line_id as string | null) ?? null,
    qty: dec(r.qty),
    unitCost: dec(r.unit_cost),
    taxRatePercent: dec(r.tax_rate_percent),
    lineTotal: dec(r.line_total),
    description: (r.description as string | null) ?? '',
    supplierSku: (r.supplier_sku as string | null) ?? null,
    productId: (r.product_id as string | null) ?? null,
    unit: (r.unit as string | null) ?? 'each',
    stockedIn: Boolean(r.stocked_in),
  }
}

const SUMMARY_SELECT = Prisma.sql`
  t."id", t."number", t."order_id", t."supplier_id", t."status", t."reason", t."raised_date",
  t."sent_at", t."currency", t."credit_expected", t."credit_received", t."credit_ref",
  t."stock_applied", t."created_by_user_id", t."created_at",
  o."number" AS "order_number", s."name" AS "supplier_name",
  COALESCE(u."displayName", u."username") AS "created_by_name",
  (SELECT count(*) FROM "po_return_lines" tl WHERE tl."return_id" = t."id") AS "line_count"
`

const SUMMARY_FROM = Prisma.sql`
  FROM "po_returns" t
  JOIN "po_orders" o ON o."id" = t."order_id"
  JOIN "po_suppliers" s ON s."id" = t."supplier_id"
  LEFT JOIN "User" u ON u."id" = t."created_by_user_id"
`

/** Every return raised against one order, newest first. */
export async function listReturnsForOrder(orderId: string): Promise<PoReturnSummary[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM}
     WHERE t."order_id" = ${orderId}
     ORDER BY t."created_at" DESC
  `
  return rows.map(mapSummary)
}

/** The Returns tab's list. `open` drops the ones nobody is waiting on any more. */
export async function listReturns(
  opts: { limit?: number; search?: string; open?: boolean } = {},
): Promise<PoReturnSummary[]> {
  const term = (opts.search ?? '').trim()
  const where: Prisma.Sql[] = []
  if (term) {
    const like = `%${term}%`
    where.push(
      Prisma.sql`(t."number" ILIKE ${like} OR o."number" ILIKE ${like} OR s."name" ILIKE ${like}
        OR t."credit_ref" ILIKE ${like} OR t."reason" ILIKE ${like})`,
    )
  }
  if (opts.open) {
    where.push(Prisma.sql`t."status" = ANY(${['DRAFT', 'SENT', 'CREDIT_EXPECTED']}::text[])`)
  }
  const whereSql = where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty
  const limit = Math.max(1, Math.min(200, Math.trunc(opts.limit ?? 50)))

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM}
     ${whereSql}
     ORDER BY t."created_at" DESC
     LIMIT ${Prisma.raw(String(limit))}
  `
  return rows.map(mapSummary)
}

export async function getReturn(id: string): Promise<PoReturn | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT}, t."notes", t."books_outcome", t."stock_applied_at", t."stock_result",
           t."updated_at"
      ${SUMMARY_FROM}
     WHERE t."id" = ${id}
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null

  // The wording and the product come off the ORDER line; the money comes off the
  // return line's own copy. `stocked_in` is the one fact that decides whether
  // sending these back has a count to take them off - the delivery they arrived
  // on was booked onto the shelf, or it was not.
  const lineRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT tl.*, l."description", l."supplier_sku", l."product_id", l."unit",
           COALESCE(rc."stock_applied", false) AS "stocked_in"
      FROM "po_return_lines" tl
      JOIN "po_order_lines" l ON l."id" = tl."order_line_id"
      LEFT JOIN "po_receipt_lines" rl ON rl."id" = tl."receipt_line_id"
      LEFT JOIN "po_receipts" rc ON rc."id" = rl."receipt_id"
     WHERE tl."return_id" = ${id}
     ORDER BY l."position" ASC, l."created_at" ASC
  `

  const lines = lineRows.map(mapLine)
  // Tax is not stored on the return header - the schema has credit_expected and
  // nothing else - so it is added back up from the lines here rather than being
  // a second figure that can drift from the first.
  const taxPence = lineRows.reduce((sum, row) => {
    const net = Math.round(Number(dec(row.line_total)) * 100)
    return sum + Math.round((net * Number(dec(row.tax_rate_percent)) * 100) / 10_000)
  }, 0)

  return {
    ...mapSummary(r),
    notes: (r.notes as string | null) ?? null,
    taxAmount: (taxPence / 100).toFixed(2),
    stockAppliedAt: stamp(r.stock_applied_at),
    stockResult: ((r.stock_result as PoStockResult | null) ?? {}) as PoStockResult,
    booksOutcome: (r.books_outcome as Record<string, unknown> | null) ?? {},
    updatedAt: stamp(r.updated_at) ?? '',
    lines,
  }
}

// ---------------------------------------------------------------------------
// What could go back
// ---------------------------------------------------------------------------

/**
 * One order's lines as the "send something back" screen offers them: what
 * arrived, what has already gone, and which deliveries each line came in on.
 *
 * Only lines that have actually been delivered are here. Nothing can be returned
 * that never turned up, and offering a line with nothing against it is an
 * invitation to raise a credit claim the supplier will laugh at.
 */
export async function listReturnableLines(orderId: string): Promise<PoReturnableLine[]> {
  const lineRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT l."id", l."description", l."supplier_sku", l."product_id", l."unit",
           l."unit_cost", l."tax_rate_percent", ${LINE_PROGRESS_SQL}
      FROM "po_order_lines" l
     WHERE l."order_id" = ${orderId}
     ORDER BY l."position" ASC, l."created_at" ASC
  `

  const receiptRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT rl."id", rl."order_line_id", rl."qty_accepted", rl."receipt_id",
           r."number", r."received_date", r."stock_applied"
      FROM "po_receipt_lines" rl
      JOIN "po_receipts" r ON r."id" = rl."receipt_id"
     WHERE r."order_id" = ${orderId} AND rl."qty_accepted" > 0
     ORDER BY r."received_date" DESC, r."created_at" DESC
  `

  const byLine = new Map<string, PoReturnableLine['receipts']>()
  for (const row of receiptRows) {
    const key = row.order_line_id as string
    const list = byLine.get(key) ?? []
    list.push({
      receiptLineId: row.id as string,
      receiptId: row.receipt_id as string,
      receiptNumber: (row.number as string | null) ?? '',
      receivedDate: day(row.received_date) ?? '',
      qtyAccepted: dec(row.qty_accepted),
      stockApplied: Boolean(row.stock_applied),
    })
    byLine.set(key, list)
  }

  return lineRows
    .map((r) => ({
      orderLineId: r.id as string,
      description: (r.description as string | null) ?? '',
      supplierSku: (r.supplier_sku as string | null) ?? null,
      productId: (r.product_id as string | null) ?? null,
      unit: (r.unit as string | null) ?? 'each',
      unitCost: dec(r.unit_cost),
      taxRatePercent: dec(r.tax_rate_percent),
      qtyReceived: dec(r.qty_received),
      qtyReturned: dec(r.qty_returned),
      receipts: byLine.get(r.id as string) ?? [],
    }))
    .filter((line) => Number(line.qtyReceived) > 0)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type ReturnLineInput = {
  orderLineId: string
  receiptLineId: string | null
  qty: string
  unitCost: string
  taxRatePercent: string
  lineTotal: string
}

export type ReturnInput = {
  orderId: string
  supplierId: string
  reason: string | null
  raisedDate: string
  currency: string
  fxRate: string
  notes: string | null
  creditExpected: string
  lines: ReturnLineInput[]
}

export async function createReturn(
  number: string,
  input: ReturnInput,
  userId: string,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "po_returns" (
        "number", "order_id", "supplier_id", "reason", "raised_date", "currency", "fx_rate",
        "notes", "credit_expected", "created_by_user_id"
      ) VALUES (
        ${number}, ${input.orderId}, ${input.supplierId}, ${input.reason}, ${input.raisedDate}::date,
        ${input.currency}, ${input.fxRate}::numeric, ${input.notes}, ${input.creditExpected}::numeric,
        ${userId}
      )
      RETURNING "id"
    `
    const returnId = rows[0]!.id
    await insertLines(tx, returnId, input.lines)
    return returnId
  })
}

/** Saves a draft over itself. Lines are replaced wholesale, which is safe
 *  because nothing anywhere references a return line. */
export async function updateReturn(id: string, input: ReturnInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "po_returns" SET
        "reason" = ${input.reason},
        "raised_date" = ${input.raisedDate}::date,
        "currency" = ${input.currency},
        "fx_rate" = ${input.fxRate}::numeric,
        "notes" = ${input.notes},
        "credit_expected" = ${input.creditExpected}::numeric,
        "updated_at" = now()
      WHERE "id" = ${id}
    `
    await tx.$executeRaw`DELETE FROM "po_return_lines" WHERE "return_id" = ${id}`
    await insertLines(tx, id, input.lines)
  })
}

async function insertLines(
  tx: Pick<typeof prisma, '$executeRaw' | '$queryRaw'>,
  returnId: string,
  lines: ReturnLineInput[],
): Promise<void> {
  for (const line of lines) {
    await tx.$executeRaw`
      INSERT INTO "po_return_lines" (
        "return_id", "order_line_id", "receipt_line_id", "qty", "unit_cost",
        "tax_rate_percent", "line_total"
      ) VALUES (
        ${returnId}, ${line.orderLineId}, ${line.receiptLineId}, ${line.qty}::numeric,
        ${line.unitCost}::numeric, ${line.taxRatePercent}::numeric, ${line.lineTotal}::numeric
      )
    `
  }
}

export async function deleteReturn(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "po_returns" WHERE "id" = ${id}`
}

export type ReturnStatusPatch = {
  creditReceived?: string | null
  creditRef?: string | null
}

/** The single write behind every return transition. Callers log the audit line. */
export async function setReturnStatus(
  id: string,
  to: PoReturnStatus,
  patch: ReturnStatusPatch = {},
): Promise<void> {
  const sets: Prisma.Sql[] = [Prisma.sql`"status" = ${to}`, Prisma.sql`"updated_at" = now()`]

  // Only ever stamped once. A note re-sent because the supplier lost the first
  // copy did not leave the building a second time.
  if (to === 'SENT') sets.push(Prisma.sql`"sent_at" = COALESCE("sent_at", now())`)
  if (patch.creditReceived !== undefined && patch.creditReceived !== null) {
    sets.push(Prisma.sql`"credit_received" = ${patch.creditReceived}::numeric`)
  }
  if (patch.creditRef !== undefined) sets.push(Prisma.sql`"credit_ref" = ${patch.creditRef}`)

  await prisma.$executeRaw`
    UPDATE "po_returns" SET ${Prisma.join(sets, ', ')} WHERE "id" = ${id}
  `
}

/** Records that the note has gone out, and to whom. Appends, because who has
 *  been told is a list rather than a fact that gets replaced. */
export async function recordReturnSent(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_returns"
       SET "sent_at" = COALESCE("sent_at", now()), "updated_at" = now()
     WHERE "id" = ${id}
  `
}

/**
 * Marks a return's stock as taken off, and refuses to do it twice.
 *
 * The guard is the WHERE clause, not a read followed by a write - the same shape
 * po_receipts uses, and for the same reason: two people pressing the button at
 * the same moment would both pass a check done in JavaScript.
 */
export async function claimReturnStock(id: string): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "po_returns"
       SET "stock_applied" = true, "stock_applied_at" = now()
     WHERE "id" = ${id} AND "stock_applied" = false
  `
  return updated > 0
}

/** Hands the claim back when the deduction could not be made after all. */
export async function releaseReturnStock(id: string, result: PoStockResult): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_returns"
       SET "stock_applied" = false, "stock_applied_at" = NULL,
           "stock_result" = ${JSON.stringify(result)}::jsonb
     WHERE "id" = ${id}
  `
}

export async function recordReturnStockResult(id: string, result: PoStockResult): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_returns" SET "stock_result" = ${JSON.stringify(result)}::jsonb WHERE "id" = ${id}
  `
}

/** One return, found by its number rather than its id - which is what the public
 *  document page has in the URL. */
export async function getReturnIdByNumber(number: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "po_returns" WHERE "number" = ${number} LIMIT 1
  `
  return rows[0]?.id ?? null
}

/** What is owed across every open return, for the Returns tab's summary line. */
export async function openCreditTotal(): Promise<{ count: number; expected: string }> {
  const rows = await prisma.$queryRaw<{ count: bigint; expected: unknown }[]>`
    SELECT count(*) AS "count",
           COALESCE(SUM(GREATEST("credit_expected" - "credit_received", 0)), 0) AS "expected"
      FROM "po_returns"
     WHERE "status" = ANY(${['SENT', 'CREDIT_EXPECTED']}::text[])
  `
  return {
    count: Number(rows[0]?.count ?? 0),
    expected: Number(dec(rows[0]?.expected)).toFixed(2),
  }
}
