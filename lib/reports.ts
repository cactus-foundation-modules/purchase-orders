import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getCapabilities } from './capabilities'
import { getPoConfigCached } from './config'
import { LINE_PROGRESS_SQL } from './progress'
import {
  commitmentBySupplier,
  defaultSpendRange,
  invoicedNotReceived,
  overdueOrders,
  receivedNotInvoiced,
  spendByMonth,
  type ReportLineFact,
} from './reporting'
import { chaseReview } from './chasing'
import { gatherChaseFacts } from './chase'
import type {
  PoDashboardSummary,
  PoReports,
  PoSpendCategory,
  PoSpendSupplier,
  PoStatus,
} from './types'

// Every read the reports need, in raw SQL as the rest of this module is.
//
// The arithmetic is NOT here. Line-level facts come out of the database with
// their received / invoiced / returned quantities already summed by the one
// shared fragment in lib/progress.ts, and lib/reporting.ts turns them into
// money. That split is the whole point: the order screen, the Reports tab, the
// dashboard tile and the exports cannot disagree about how much of a line has
// turned up, because there is one place that decides.
//
// The one thing that IS aggregated in SQL is spend, because a year of supplier
// invoices is a great many rows to pull across to add up, and a bill's figures
// are settled - nothing about them is derived from anything else.

/**
 * How many order lines a report will look at.
 *
 * Only lines that still have something unresolved about them come back at all
 * (see the WHERE below), so this bites on a site with tens of thousands of them
 * open at once. When it does bite the screen says so out loud rather than
 * quietly reporting a smaller number than the truth.
 */
const LINE_FACT_CAP = 20_000

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

/** Today on the server's own clock, as a plain day. */
export function reportToday(): string {
  return new Date().toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// The line facts
// ---------------------------------------------------------------------------

/**
 * Every order line with something still unresolved about it.
 *
 * "Unresolved" means one of two things, and the WHERE says both: something is
 * still to come, or what has arrived and what has been invoiced do not agree. A
 * line that was ordered, arrived and was invoiced in full contributes nothing to
 * any of these reports, so it never leaves the database.
 *
 * Cancelled orders are dropped here rather than in the arithmetic: nothing on a
 * cancelled order is owed, accrued or late, and carrying them across only to
 * throw them away wastes the one query that matters.
 */
export async function gatherLineFacts(): Promise<{ facts: ReportLineFact[]; truncated: boolean }> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."id" AS "order_id", o."number" AS "order_number", o."status", o."supplier_id",
           s."name" AS "supplier_name", o."currency", o."fx_rate", o."tax_mode",
           o."sent_at", o."expected_date", o."required_by_date",
           l."description", l."qty", l."qty_cancelled", l."unit_cost",
           l."discount_percent", l."tax_rate_percent",
           p."qty_received", p."qty_invoiced", p."qty_returned"
      FROM "po_order_lines" l
      JOIN "po_orders" o ON o."id" = l."order_id"
      JOIN "po_suppliers" s ON s."id" = o."supplier_id"
      CROSS JOIN LATERAL (SELECT ${LINE_PROGRESS_SQL}) p
     WHERE o."status" <> 'CANCELLED'
       AND (
         (l."qty" - l."qty_cancelled") <> (p."qty_received" - p."qty_returned")
         OR (p."qty_received" - p."qty_returned") <> p."qty_invoiced"
       )
     ORDER BY o."created_at" DESC
     LIMIT ${Prisma.raw(String(LINE_FACT_CAP + 1))}
  `

  const truncated = rows.length > LINE_FACT_CAP
  const facts = rows.slice(0, LINE_FACT_CAP).map(
    (r): ReportLineFact => ({
      orderId: r.order_id as string,
      orderNumber: r.order_number as string,
      orderStatus: r.status as PoStatus,
      supplierId: r.supplier_id as string,
      supplierName: r.supplier_name as string,
      currency: r.currency as string,
      fxRate: dec(r.fx_rate),
      taxMode: (r.tax_mode as 'EXCLUSIVE' | 'INCLUSIVE') ?? 'EXCLUSIVE',
      sentAt: stamp(r.sent_at),
      expectedDate: day(r.expected_date),
      requiredByDate: day(r.required_by_date),
      description: r.description as string,
      qty: dec(r.qty),
      qtyCancelled: dec(r.qty_cancelled),
      qtyReceived: dec(r.qty_received),
      qtyInvoiced: dec(r.qty_invoiced),
      qtyReturned: dec(r.qty_returned),
      unitCost: dec(r.unit_cost),
      discountPercent: r.discount_percent === null || r.discount_percent === undefined ? null : String(r.discount_percent),
      taxRatePercent: dec(r.tax_rate_percent),
    }),
  )

  return { facts, truncated }
}

/**
 * When each order was last chased, off the audit log.
 *
 * There is no `last_chased_at` column and there deliberately is not one: this
 * module has answered every other "when did we last" question from its own log,
 * the log is where somebody looks anyway, and a column would have meant a
 * migration for a fact the log already holds.
 */
export async function lastChasedByOrder(orderIds: string[]): Promise<Record<string, string | null>> {
  if (orderIds.length === 0) return {}
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "entity_id", MAX("created_at") AS "last"
      FROM "po_audit_log"
     WHERE "entity_type" = 'order' AND "action" = 'order.chased'
       AND "entity_id" = ANY(${orderIds}::text[])
     GROUP BY "entity_id"
  `
  const out: Record<string, string | null> = {}
  for (const row of rows) out[row.entity_id as string] = stamp(row.last)
  return out
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------
//
// Net of VAT throughout, and net is the only figure the three cuts can all
// produce: a bill line carries a net amount and a category, carriage carries a
// net amount and no category, and VAT belongs to a return the site makes rather
// than to a supplier it buys from.
//
// Bills that count are the ones somebody has agreed to pay - approved, and the
// ones already in the books. A draft nobody has looked at and a queried one
// nobody has settled are not spend yet, and a void one never was.

const SPEND_BILL_STATUSES = ['APPROVED', 'POSTED']

/** Bill money in the base currency: subtotal and carriage, at the bill's own rate. */
const BILL_NET_SQL = Prisma.sql`ROUND((b."subtotal" + b."carriage_amount") * b."fx_rate", 2)`

/**
 * A supplier credit, net, off its own lines.
 *
 * Not `credit_received`: that figure is gross, and taking a gross credit off a
 * net spend leaves the VAT on the return looking like a discount. The lines are
 * what the category and supplier cuts are built from anyway, so the credit is
 * built the same way.
 *
 * Counted in the month the return was RAISED rather than the month the money
 * came back. There is no `credited_at` column and adding one would have meant a
 * migration for a figure nobody reconciles to the day - and the return is the
 * event the purchasing side actually caused.
 */
const CREDIT_LINE_TOTALS = Prisma.sql`
  SELECT "return_id", SUM("line_total") AS "net" FROM "po_return_lines" GROUP BY "return_id"
`

const CREDIT_DAY = Prisma.sql`COALESCE(t."raised_date", t."created_at"::date)`

async function billSpendBySupplier(from: string, to: string): Promise<Map<string, { net: number; count: number }>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT b."supplier_id", SUM(${BILL_NET_SQL}) AS "net", count(*) AS "bills"
      FROM "po_bills" b
     WHERE b."status" = ANY(${SPEND_BILL_STATUSES}::text[])
       AND b."invoice_date" >= ${from}::date AND b."invoice_date" <= ${to}::date
     GROUP BY b."supplier_id"
  `
  const out = new Map<string, { net: number; count: number }>()
  for (const row of rows) {
    out.set(row.supplier_id as string, { net: Number(row.net ?? 0), count: Number(row.bills ?? 0) })
  }
  return out
}

async function creditsBySupplier(from: string, to: string): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT t."supplier_id",
           SUM(ROUND(COALESCE(l."net", 0) * COALESCE(t."fx_rate", 1), 2)) AS "net"
      FROM "po_returns" t
      LEFT JOIN (${CREDIT_LINE_TOTALS}) l ON l."return_id" = t."id"
     WHERE t."status" = 'CREDITED'
       AND ${CREDIT_DAY} >= ${from}::date AND ${CREDIT_DAY} <= ${to}::date
     GROUP BY t."supplier_id"
  `
  const out = new Map<string, number>()
  for (const row of rows) out.set(row.supplier_id as string, Number(row.net ?? 0))
  return out
}

async function billSpendByMonth(from: string, to: string): Promise<{ month: string; value: string }[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT to_char(b."invoice_date", 'YYYY-MM') AS "month", SUM(${BILL_NET_SQL}) AS "net"
      FROM "po_bills" b
     WHERE b."status" = ANY(${SPEND_BILL_STATUSES}::text[])
       AND b."invoice_date" >= ${from}::date AND b."invoice_date" <= ${to}::date
     GROUP BY 1
  `
  return rows.map((r) => ({ month: r.month as string, value: dec(r.net) }))
}

async function creditsByMonth(from: string, to: string): Promise<{ month: string; value: string }[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT to_char(${CREDIT_DAY}, 'YYYY-MM') AS "month",
           SUM(ROUND(COALESCE(l."net", 0) * COALESCE(t."fx_rate", 1), 2)) AS "net"
      FROM "po_returns" t
      LEFT JOIN (${CREDIT_LINE_TOTALS}) l ON l."return_id" = t."id"
     WHERE t."status" = 'CREDITED'
       AND ${CREDIT_DAY} >= ${from}::date AND ${CREDIT_DAY} <= ${to}::date
     GROUP BY 1
  `
  return rows.map((r) => ({ month: r.month as string, value: dec(r.net) }))
}

/**
 * Spend under each bookkeeping category.
 *
 * Carriage is deliberately absent: it hangs off the bill rather than off a line
 * and therefore carries no category, so adding it in under "uncategorised" would
 * invent a category nobody chose. The screen says the cut is lines only, which
 * is why it can come to less than the supplier total beside it.
 */
async function spendByCategory(from: string, to: string): Promise<PoSpendCategory[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT bl."category_id",
           SUM(ROUND(bl."line_total" * b."fx_rate", 2)) AS "net",
           count(*) AS "lines"
      FROM "po_bill_lines" bl
      JOIN "po_bills" b ON b."id" = bl."bill_id"
     WHERE b."status" = ANY(${SPEND_BILL_STATUSES}::text[])
       AND b."invoice_date" >= ${from}::date AND b."invoice_date" <= ${to}::date
     GROUP BY bl."category_id"
  `

  const ids = rows.map((r) => r.category_id).filter((id): id is string => typeof id === 'string' && id !== '')
  const names = await bookCategoryNames(ids)

  return rows
    .map((r) => {
      const id = typeof r.category_id === 'string' && r.category_id !== '' ? r.category_id : null
      return {
        categoryId: id,
        categoryName: id ? (names.get(id) ?? null) : null,
        net: dec(r.net),
        lineCount: Number(r.lines ?? 0),
      }
    })
    .sort((a, b) => Number(b.net) - Number(a.net))
}

/**
 * Category names, where there are books to read them from.
 *
 * Guarded and swallowed exactly as every other cross-module read in this module
 * is: a purchasing report must still draw on a site with no bookkeeping, where
 * the ids are simply ids and the screen says as much.
 */
async function bookCategoryNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const { hasBooks } = await getCapabilities()
  if (!hasBooks) return out
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "name" FROM "bk_categories" WHERE "id" = ANY(${ids}::text[])
    `
    for (const row of rows) out.set(row.id as string, row.name as string)
  } catch {
    // Half-migrated books are not a reason a purchasing report should fail to
    // draw. The ids stand in for the names for the day.
  }
  return out
}

// ---------------------------------------------------------------------------
// The whole tab, in one call
// ---------------------------------------------------------------------------

export async function buildReports(range?: { from?: string | null; to?: string | null }): Promise<
  PoReports & { truncated: boolean }
> {
  const today = reportToday()
  const fallback = defaultSpendRange(today)
  const from = (range?.from ?? '').slice(0, 10) || fallback.from
  const to = (range?.to ?? '').slice(0, 10) || fallback.to

  const [config, capabilities, lineFacts, chaseFacts] = await Promise.all([
    getPoConfigCached(),
    getCapabilities(),
    gatherLineFacts(),
    gatherChaseFacts(),
  ])

  const orderIds = [...new Set(lineFacts.facts.map((f) => f.orderId))]
  const [chased, billsBySupplier, credits, billMonths, creditMonths, byCategory, supplierNames] =
    await Promise.all([
      lastChasedByOrder(orderIds),
      billSpendBySupplier(from, to),
      creditsBySupplier(from, to),
      billSpendByMonth(from, to),
      creditsByMonth(from, to),
      spendByCategory(from, to),
      supplierNameMap(),
    ])

  const bySupplier: PoSpendSupplier[] = [...new Set([...billsBySupplier.keys(), ...credits.keys()])]
    .map((supplierId) => {
      const billed = billsBySupplier.get(supplierId)?.net ?? 0
      const credited = credits.get(supplierId) ?? 0
      return {
        supplierId,
        supplierName: supplierNames.get(supplierId) ?? 'A supplier who is no longer on file',
        billed: billed.toFixed(2),
        credited: credited.toFixed(2),
        net: (billed - credited).toFixed(2),
        billCount: billsBySupplier.get(supplierId)?.count ?? 0,
      }
    })
    .sort((a, b) => Number(b.net) - Number(a.net) || a.supplierName.localeCompare(b.supplierName))

  const byMonth = spendByMonth(billMonths, creditMonths, from, to)
  const billedTotal = byMonth.reduce((sum, point) => sum + Number(point.billed), 0)
  const creditedTotal = byMonth.reduce((sum, point) => sum + Number(point.credited), 0)

  const committed = commitmentBySupplier(lineFacts.facts)

  return {
    baseCurrency: config.baseCurrency,
    from,
    to,
    today,
    hasBooks: capabilities.hasBooks,
    truncated: lineFacts.truncated,
    committed: {
      total: committed.total,
      orderCount: committed.orderCount,
      suppliers: committed.suppliers,
    },
    overdue: overdueOrders(lineFacts.facts, today, chased),
    receivedNotInvoiced: receivedNotInvoiced(lineFacts.facts),
    invoicedNotReceived: invoicedNotReceived(lineFacts.facts),
    spend: {
      billed: billedTotal.toFixed(2),
      credited: creditedTotal.toFixed(2),
      net: (billedTotal - creditedTotal).toFixed(2),
      byMonth,
      bySupplier,
      byCategory,
    },
    chase: {
      enabled: config.chaseEnabled,
      afterDays: config.chaseAfterDays,
      repeatDays: config.chaseRepeatDays,
      decisions: chaseReview(
        chaseFacts.map((fact) => ({ ...fact, lastChasedAt: chased[fact.orderId] ?? fact.lastChasedAt })),
        config,
        today,
      ),
    },
  }
}

async function supplierNameMap(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "name" FROM "po_suppliers"
  `
  const out = new Map<string, string>()
  for (const row of rows) out.set(row.id as string, row.name as string)
  return out
}

// ---------------------------------------------------------------------------
// The dashboard tile
// ---------------------------------------------------------------------------

/**
 * The four figures the admin dashboard shows, off the same facts as the tab.
 *
 * Deliberately not its own set of SQL sums. A tile disagreeing with the screen
 * it links to is worse than no tile, and the line facts are already limited to
 * work that is genuinely open - so the cost of sharing the arithmetic is one
 * query on a page that already runs several.
 */
export async function poDashboardSummary(): Promise<PoDashboardSummary> {
  const today = reportToday()
  const [config, lineFacts, billRows] = await Promise.all([
    getPoConfigCached(),
    gatherLineFacts(),
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS "count" FROM "po_bills" WHERE "status" = ANY(${['DRAFT', 'QUERIED']}::text[])
    `,
  ])

  const committed = commitmentBySupplier(lineFacts.facts)

  return {
    baseCurrency: config.baseCurrency,
    openOrders: committed.orderCount,
    committedValue: committed.total,
    overdueCount: overdueOrders(lineFacts.facts, today).length,
    billsToLookAt: Number(billRows[0]?.count ?? 0),
  }
}
