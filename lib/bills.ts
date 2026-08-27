import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { LINE_PROGRESS_SQL } from './progress'
import { getCapabilities } from './capabilities'
import { getPoConfigCached } from './config'
import { matchBill } from './billing'
import type {
  PoBill,
  PoBillAttachment,
  PoBillLine,
  PoBillStatus,
  PoBillSummary,
  PoBillTotals,
  PoBillVariance,
  PoBillableLine,
  PoBookCategory,
  PoMatchStatus,
} from './types'

// Supplier bills. Raw SQL like the rest of the module, because the po_ tables
// are not in the generated Prisma client.
//
// A bill keeps its own copy of every figure. It has to: the whole document is
// somebody else's assertion about what we owe, and an order line re-priced next
// month must not silently re-write an invoice that was approved and paid in
// March. The only thing read live off the order is the MATCH, and that is
// recomputed rather than stored - see refreshBillMatch.

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

function variances(value: unknown): PoBillVariance[] {
  return Array.isArray(value) ? (value as PoBillVariance[]) : []
}

function mapSummary(r: Record<string, unknown>): PoBillSummary {
  return {
    id: r.id as string,
    supplierId: r.supplier_id as string,
    supplierName: (r.supplier_name as string | null) ?? '',
    orderId: (r.order_id as string | null) ?? null,
    orderNumber: (r.order_number as string | null) ?? null,
    supplierInvoiceNumber: r.supplier_invoice_number as string,
    invoiceDate: day(r.invoice_date) ?? '',
    dueDate: day(r.due_date),
    currency: (r.currency as string | null) ?? 'GBP',
    total: dec(r.total),
    status: r.status as PoBillStatus,
    matchStatus: r.match_status as PoMatchStatus,
    varianceCount: variances(r.variance).length,
    hasAttachment: Boolean(r.attachment_media_id),
    lineCount: Number(r.line_count ?? 0),
    createdByUserId: (r.created_by_user_id as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: stamp(r.created_at) ?? '',
  }
}

function mapLine(r: Record<string, unknown>): PoBillLine {
  return {
    id: r.id as string,
    orderLineId: (r.order_line_id as string | null) ?? null,
    description: (r.description as string | null) ?? '',
    qty: dec(r.qty),
    unitCost: dec(r.unit_cost),
    taxRatePercent: dec(r.tax_rate_percent),
    taxRateCode: (r.tax_rate_code as string | null) ?? null,
    vatTreatment: (r.vat_treatment as string | null) ?? null,
    categoryId: (r.category_id as string | null) ?? null,
    lineTotal: dec(r.line_total),
  }
}

const SUMMARY_SELECT = Prisma.sql`
  b."id", b."supplier_id", b."order_id", b."supplier_invoice_number", b."invoice_date",
  b."due_date", b."currency", b."total", b."status", b."match_status", b."variance",
  b."attachment_media_id", b."created_by_user_id", b."created_at",
  s."name" AS "supplier_name", o."number" AS "order_number",
  COALESCE(u."displayName", u."username") AS "created_by_name",
  (SELECT count(*) FROM "po_bill_lines" bl WHERE bl."bill_id" = b."id") AS "line_count"
`

const SUMMARY_FROM = Prisma.sql`
  FROM "po_bills" b
  JOIN "po_suppliers" s ON s."id" = b."supplier_id"
  LEFT JOIN "po_orders" o ON o."id" = b."order_id"
  LEFT JOIN "User" u ON u."id" = b."created_by_user_id"
`

/** Everything nobody has agreed to pay yet, and everything that is queried. */
const OPEN_STATUSES: PoBillStatus[] = ['DRAFT', 'QUERIED']

export async function listBillsForOrder(orderId: string): Promise<PoBillSummary[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM}
     WHERE b."order_id" = ${orderId}
     ORDER BY b."invoice_date" DESC, b."created_at" DESC
  `
  return rows.map(mapSummary)
}

export type BillFilters = {
  search?: string
  status?: PoBillStatus | 'ALL' | 'OPEN'
  supplierId?: string
  /** Only the ones the match does not like. */
  variance?: boolean
  limit?: number
}

export async function listBills(filters: BillFilters = {}): Promise<PoBillSummary[]> {
  const where: Prisma.Sql[] = []
  const term = (filters.search ?? '').trim()
  if (term) {
    const like = `%${term}%`
    where.push(
      Prisma.sql`(b."supplier_invoice_number" ILIKE ${like} OR s."name" ILIKE ${like}
        OR o."number" ILIKE ${like})`,
    )
  }
  if (filters.status === 'OPEN') {
    where.push(Prisma.sql`b."status" = ANY(${OPEN_STATUSES}::text[])`)
  } else if (filters.status && filters.status !== 'ALL') {
    where.push(Prisma.sql`b."status" = ${filters.status}`)
  }
  if (filters.supplierId) where.push(Prisma.sql`b."supplier_id" = ${filters.supplierId}`)
  if (filters.variance) where.push(Prisma.sql`b."match_status" = 'VARIANCE'`)

  const whereSql = where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty
  const limit = Math.max(1, Math.min(200, Math.trunc(filters.limit ?? 50)))

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM}
     ${whereSql}
     ORDER BY b."invoice_date" DESC, b."created_at" DESC
     LIMIT ${Prisma.raw(String(limit))}
  `
  return rows.map(mapSummary)
}

export async function getBill(id: string): Promise<PoBill | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT}, b."fx_rate", b."subtotal", b."carriage_amount", b."tax_amount",
           b."query_note", b."approved_by_user_id", b."approved_at", b."posted_at",
           b."books_outcome", b."updated_at",
           COALESCE(a."displayName", a."username") AS "approved_by_name",
           m."url" AS "media_url", m."originalName" AS "media_name", m."key" AS "media_key",
           m."mimeType" AS "media_mime", m."sizeBytes" AS "media_size"
      ${SUMMARY_FROM}
      LEFT JOIN "User" a ON a."id" = b."approved_by_user_id"
      LEFT JOIN "Media" m ON m."id" = b."attachment_media_id"
     WHERE b."id" = ${id}
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null

  const lineRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT bl.* FROM "po_bill_lines" bl
     WHERE bl."bill_id" = ${id}
     ORDER BY bl."id" ASC
  `

  // The library row can be deleted underneath us. The id stays on the bill
  // either way - it is the record of what was attached - but there is nothing
  // to link to any more, and saying so beats an anchor that 404s.
  const mediaId = (r.attachment_media_id as string | null) ?? null
  const attachment: PoBillAttachment | null =
    mediaId && r.media_url
      ? {
          mediaId,
          url: r.media_url as string,
          name:
            (r.media_name as string | null) ??
            String(r.media_key ?? '').split('/').pop() ??
            'Their invoice',
          mimeType: (r.media_mime as string | null) ?? 'application/octet-stream',
          sizeBytes: Number(r.media_size ?? 0),
        }
      : null

  return {
    ...mapSummary(r),
    fxRate: dec(r.fx_rate),
    subtotal: dec(r.subtotal),
    carriageAmount: dec(r.carriage_amount),
    taxAmount: dec(r.tax_amount),
    variance: variances(r.variance),
    queryNote: (r.query_note as string | null) ?? null,
    approvedByUserId: (r.approved_by_user_id as string | null) ?? null,
    approvedByName: (r.approved_by_name as string | null) ?? null,
    approvedAt: stamp(r.approved_at),
    postedAt: stamp(r.posted_at),
    booksOutcome: (r.books_outcome as Record<string, unknown> | null) ?? {},
    attachment,
    updatedAt: stamp(r.updated_at) ?? '',
    lines: lineRows.map(mapLine),
  }
}

// ---------------------------------------------------------------------------
// What could be billed
// ---------------------------------------------------------------------------

/**
 * One order's lines as the bill screen offers them: what was ordered, what
 * turned up, and what has already been invoiced on OTHER bills.
 *
 * `exceptBillId` is what keeps a saved draft editable. Without it, a bill's own
 * lines would count against it the second time somebody opened it, and every
 * save would flag the invoice as claiming twice for the same goods.
 */
export async function listBillableLines(
  orderId: string,
  exceptBillId: string | null = null,
): Promise<PoBillableLine[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT l."id", l."description", l."supplier_sku", l."unit", l."unit_cost",
           l."tax_rate_percent", l."tax_rate_code", l."vat_treatment", l."category_id",
           l."qty", l."qty_cancelled", ${LINE_PROGRESS_SQL},
           COALESCE((
             SELECT SUM(bl."qty") FROM "po_bill_lines" bl
              WHERE bl."order_line_id" = l."id"
                AND (${exceptBillId}::text IS NULL OR bl."bill_id" <> ${exceptBillId})
           ), 0) AS "qty_invoiced_others"
      FROM "po_order_lines" l
     WHERE l."order_id" = ${orderId}
     ORDER BY l."position" ASC, l."created_at" ASC
  `

  return rows.map((r) => ({
    orderLineId: r.id as string,
    description: (r.description as string | null) ?? '',
    supplierSku: (r.supplier_sku as string | null) ?? null,
    unit: (r.unit as string | null) ?? 'each',
    unitCost: dec(r.unit_cost),
    taxRatePercent: dec(r.tax_rate_percent),
    taxRateCode: (r.tax_rate_code as string | null) ?? null,
    vatTreatment: (r.vat_treatment as string | null) ?? null,
    categoryId: (r.category_id as string | null) ?? null,
    qtyOrdered: dec(r.qty),
    qtyCancelled: dec(r.qty_cancelled),
    qtyReceived: dec(r.qty_received),
    qtyInvoiced: dec(r.qty_invoiced_others),
  }))
}

/** Every line of an order with what has been invoiced against it, for the
 *  question of whether the order can now close itself. */
export async function orderInvoicedLines(orderId: string): Promise<
  { qty: string; qtyCancelled: string; qtyReceived: string; qtyInvoiced: string }[]
> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT l."qty", l."qty_cancelled", ${LINE_PROGRESS_SQL}
      FROM "po_order_lines" l
     WHERE l."order_id" = ${orderId}
  `
  return rows.map((r) => ({
    qty: dec(r.qty),
    qtyCancelled: dec(r.qty_cancelled),
    qtyReceived: dec(r.qty_received),
    qtyInvoiced: dec(r.qty_invoiced),
  }))
}

/** How many returns on this order are still waiting for their money. */
export async function openReturnCount(orderId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS "count" FROM "po_returns"
     WHERE "order_id" = ${orderId}
       AND "status" = ANY(${['DRAFT', 'SENT', 'CREDIT_EXPECTED']}::text[])
  `
  return Number(rows[0]?.count ?? 0)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type BillLineInput = {
  orderLineId: string | null
  description: string
  qty: string
  unitCost: string
  taxRatePercent: string
  taxRateCode: string | null
  vatTreatment: string | null
  categoryId: string | null
  lineTotal: string
}

export type BillInput = {
  supplierId: string
  orderId: string | null
  supplierInvoiceNumber: string
  invoiceDate: string
  dueDate: string | null
  currency: string
  fxRate: string
  subtotal: string
  carriageAmount: string
  taxAmount: string
  total: string
  lines: BillLineInput[]
}

/** Raised when the supplier has already billed us under this number. The unique
 *  index is what decides, not a SELECT beforehand: two people typing the same
 *  invoice in at the same moment would both pass a check done in JavaScript. */
export class DuplicateInvoiceError extends Error {
  constructor(number: string) {
    super(`This supplier has already billed you under invoice ${number}.`)
    this.name = 'DuplicateInvoiceError'
  }
}

function rethrowDuplicate(error: unknown, number: string): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('po_bills_supplier_invoice_unique')) throw new DuplicateInvoiceError(number)
  throw error
}

export async function createBill(input: BillInput, userId: string): Promise<string> {
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "po_bills" (
          "supplier_id", "order_id", "supplier_invoice_number", "invoice_date", "due_date",
          "currency", "fx_rate", "subtotal", "carriage_amount", "tax_amount", "total",
          "created_by_user_id"
        ) VALUES (
          ${input.supplierId}, ${input.orderId}, ${input.supplierInvoiceNumber},
          ${input.invoiceDate}::date, ${input.dueDate}::date, ${input.currency},
          ${input.fxRate}::numeric, ${input.subtotal}::numeric, ${input.carriageAmount}::numeric,
          ${input.taxAmount}::numeric, ${input.total}::numeric, ${userId}
        )
        RETURNING "id"
      `
      const billId = rows[0]!.id
      await insertLines(tx, billId, input.lines)
      return billId
    })
  } catch (error) {
    rethrowDuplicate(error, input.supplierInvoiceNumber)
  }
}

/** Saves a bill over itself. Lines are replaced wholesale, which is safe because
 *  nothing anywhere references a bill line - the match reads them, and reads
 *  them fresh every time. */
export async function updateBill(id: string, input: BillInput): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "po_bills" SET
          "supplier_id" = ${input.supplierId},
          "order_id" = ${input.orderId},
          "supplier_invoice_number" = ${input.supplierInvoiceNumber},
          "invoice_date" = ${input.invoiceDate}::date,
          "due_date" = ${input.dueDate}::date,
          "currency" = ${input.currency},
          "fx_rate" = ${input.fxRate}::numeric,
          "subtotal" = ${input.subtotal}::numeric,
          "carriage_amount" = ${input.carriageAmount}::numeric,
          "tax_amount" = ${input.taxAmount}::numeric,
          "total" = ${input.total}::numeric,
          "updated_at" = now()
        WHERE "id" = ${id}
      `
      await tx.$executeRaw`DELETE FROM "po_bill_lines" WHERE "bill_id" = ${id}`
      await insertLines(tx, id, input.lines)
    })
  } catch (error) {
    rethrowDuplicate(error, input.supplierInvoiceNumber)
  }
}

async function insertLines(
  tx: Pick<typeof prisma, '$executeRaw' | '$queryRaw'>,
  billId: string,
  lines: BillLineInput[],
): Promise<void> {
  for (const line of lines) {
    await tx.$executeRaw`
      INSERT INTO "po_bill_lines" (
        "bill_id", "order_line_id", "description", "qty", "unit_cost", "tax_rate_percent",
        "tax_rate_code", "vat_treatment", "category_id", "line_total"
      ) VALUES (
        ${billId}, ${line.orderLineId}, ${line.description}, ${line.qty}::numeric,
        ${line.unitCost}::numeric, ${line.taxRatePercent}::numeric, ${line.taxRateCode},
        ${line.vatTreatment}, ${line.categoryId}, ${line.lineTotal}::numeric
      )
    `
  }
}

export async function deleteBill(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "po_bills" WHERE "id" = ${id}`
}

export type BillStatusPatch = { queryNote?: string | null }

/** The single write behind every bill transition. Callers log the audit line. */
export async function setBillStatus(
  id: string,
  to: PoBillStatus,
  patch: BillStatusPatch = {},
): Promise<void> {
  const sets: Prisma.Sql[] = [Prisma.sql`"status" = ${to}`, Prisma.sql`"updated_at" = now()`]

  if (to === 'APPROVED') {
    sets.push(Prisma.sql`"approved_at" = now()`)
  }
  // Taking an approval back clears it rather than leaving a stamp saying the
  // bill was approved by somebody who has since changed their mind.
  if (to === 'DRAFT') {
    sets.push(Prisma.sql`"approved_at" = NULL`, Prisma.sql`"approved_by_user_id" = NULL`)
  }
  if (patch.queryNote !== undefined) sets.push(Prisma.sql`"query_note" = ${patch.queryNote}`)

  await prisma.$executeRaw`
    UPDATE "po_bills" SET ${Prisma.join(sets, ', ')} WHERE "id" = ${id}
  `
}

/** Who approved it, stamped alongside the status by the transition route. */
export async function setBillApprover(id: string, userId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_bills" SET "approved_by_user_id" = ${userId} WHERE "id" = ${id}
  `
}

export async function saveBillMatch(
  id: string,
  status: PoMatchStatus,
  flags: PoBillVariance[],
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_bills"
       SET "match_status" = ${status}, "variance" = ${JSON.stringify(flags)}::jsonb
     WHERE "id" = ${id}
  `
}

/**
 * What the books said, and - only when they took it - the stamp that says so.
 *
 * Two writes rather than one, and the status write is guarded on APPROVED: the
 * only path from "approved to pay" to "in the books" is a set of books actually
 * accepting the entry. A bill that is void, or that somebody unapproved while a
 * slow handoff was in flight, is left exactly where it is.
 */
export async function setBillBooksOutcome(
  id: string,
  outcome: unknown,
  posted: boolean,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_bills"
       SET "books_outcome" = ${JSON.stringify(outcome ?? {})}::jsonb, "updated_at" = now()
     WHERE "id" = ${id}
  `
  if (!posted) return
  await prisma.$executeRaw`
    UPDATE "po_bills"
       SET "status" = 'POSTED', "posted_at" = now(), "updated_at" = now()
     WHERE "id" = ${id} AND "status" = 'APPROVED'
  `
}

export async function setBillAttachment(id: string, mediaId: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_bills" SET "attachment_media_id" = ${mediaId}, "updated_at" = now()
     WHERE "id" = ${id}
  `
}

// ---------------------------------------------------------------------------
// The numbers the tab leads with
// ---------------------------------------------------------------------------

export async function billSummaryTotals(): Promise<PoBillTotals> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT
      count(*) FILTER (WHERE "status" = ANY(${OPEN_STATUSES}::text[])) AS "open_count",
      COALESCE(SUM("total") FILTER (WHERE "status" = ANY(${OPEN_STATUSES}::text[])), 0) AS "open_total",
      count(*) FILTER (WHERE "status" = 'QUERIED') AS "queried_count",
      count(*) FILTER (WHERE "status" = 'APPROVED') AS "approved_count",
      COALESCE(SUM("total") FILTER (WHERE "status" = 'APPROVED'), 0) AS "approved_total"
      FROM "po_bills"
  `
  const r = rows[0] ?? {}
  return {
    openCount: Number(r.open_count ?? 0),
    openTotal: Number(dec(r.open_total)).toFixed(2),
    queriedCount: Number(r.queried_count ?? 0),
    approvedCount: Number(r.approved_count ?? 0),
    approvedTotal: Number(dec(r.approved_total)).toFixed(2),
  }
}

// ---------------------------------------------------------------------------
// The books, read at arm's length
// ---------------------------------------------------------------------------

/**
 * The expense categories a bill line can be filed under.
 *
 * Read by raw SQL and only when the books are actually installed - this module
 * never imports from '@/modules/uk-bookkeeping/...', a directory that does not
 * exist at build time on a site without it. An empty list is a perfectly good
 * answer: the column is then a plain string nobody has to fill in.
 */
export async function listBookCategories(): Promise<PoBookCategory[]> {
  const { hasBooks } = await getCapabilities()
  if (!hasBooks) return []
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "code", "name" FROM "bk_categories"
       WHERE "archived" = false AND "direction" = ANY(${['expense', 'both']}::text[])
       ORDER BY "position" ASC, "name" ASC
    `
    return rows.map((r) => ({ id: r.id as string, code: r.code as string, name: r.name as string }))
  } catch {
    // The books being half-migrated is not a reason the purchasing screen should
    // fail to draw. No categories, and the field is free text for the day.
    return []
  }
}

// ---------------------------------------------------------------------------
// Keeping the match honest
// ---------------------------------------------------------------------------

/**
 * Re-run the three-way match on one bill and store what it found.
 *
 * The match is DERIVED, never typed, and it is deliberately recomputed rather
 * than left where it was written: a delivery booked in an hour after the invoice
 * was typed changes the answer, and a screen still showing yesterday's verdict is
 * how a perfectly good invoice sits queried for a fortnight.
 *
 * Callers pass `only` to say when it may run. Once a bill is approved the
 * recorded variance is the record of what somebody agreed to pay in spite of, and
 * a later delivery must not quietly tidy that away - see `isMatchLive`.
 */
export async function refreshBillMatch(id: string): Promise<{ status: PoMatchStatus; flags: PoBillVariance[] } | null> {
  const bill = await getBill(id)
  if (!bill) return null

  const config = await getPoConfigCached()
  const orderLines = bill.orderId ? await listBillableLines(bill.orderId, id) : []

  const match = matchBill(
    Boolean(bill.orderId),
    orderLines.map((line) => ({
      id: line.orderLineId,
      description: line.description,
      qty: line.qtyOrdered,
      qtyCancelled: line.qtyCancelled,
      qtyReceived: line.qtyReceived,
      qtyInvoicedElsewhere: line.qtyInvoiced,
      unitCost: line.unitCost,
    })),
    bill.lines.map((line) => ({
      orderLineId: line.orderLineId,
      description: line.description,
      qty: line.qty,
      unitCost: line.unitCost,
    })),
    {
      pricePercent: config.priceVarianceTolerancePercent,
      quantityPercent: config.quantityVarianceTolerancePercent,
    },
  )

  const unchanged =
    match.status === bill.matchStatus &&
    JSON.stringify(match.flags) === JSON.stringify(bill.variance)
  if (!unchanged) await saveBillMatch(id, match.status, match.flags)

  return match
}
