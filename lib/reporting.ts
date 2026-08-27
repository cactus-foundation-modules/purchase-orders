import { fromPence, lineAmounts, scaled } from './totals'
import type {
  PoAccrualRow,
  PoCommitmentSupplier,
  PoOverdueOrder,
  PoStatus,
  PoSpendPoint,
} from './types'

// The reporting arithmetic, and nothing else.
//
// Pure by design, exactly as lib/reordering.ts is: no database, no clock, no
// config reader. The Reports tab, the dashboard tile and the CSV export all hand
// this file the same facts and get the same answer, which is the only way three
// screens showing "what we have committed to" can be trusted to agree.
//
// Two rules run through all of it:
//
//  1. **Quantities are derived, never counted.** Every fact row arrives with its
//     received / invoiced / returned figures already summed by the one shared
//     fragment in lib/progress.ts. Nothing here re-derives them, so a deleted
//     delivery changes every report at once.
//  2. **Money is added up in pence, then converted once.** Each line's net comes
//     through lib/totals.ts in its own currency, and only the final figure is
//     multiplied by the order's rate into the base currency. Converting first
//     and adding after is how a report ends up a penny out from the order screen
//     it was read off.

/** What one order line contributes to every report, in one row. */
export type ReportLineFact = {
  orderId: string
  orderNumber: string
  orderStatus: PoStatus
  supplierId: string
  supplierName: string
  /** The supplier's currency, which may not be the base one. */
  currency: string
  /** Base currency per 1 unit of the order's currency, as at raise. */
  fxRate: string
  taxMode: 'EXCLUSIVE' | 'INCLUSIVE'
  /** Set once the order actually went to the supplier. Null means nobody has
   *  been promised anything yet. */
  sentAt: string | null
  expectedDate: string | null
  requiredByDate: string | null
  description: string
  qty: string
  qtyCancelled: string
  qtyReceived: string
  qtyInvoiced: string
  qtyReturned: string
  unitCost: string
  discountPercent: string | null
  taxRatePercent: string
}

/**
 * Statuses in which an order is no longer a commitment to anybody.
 *
 * A cancelled order is off the table, and a closed one has been called finished
 * by a person - keeping either in a "what we owe suppliers" figure is how that
 * figure stops being believed.
 */
const COMMITMENT_ENDED: PoStatus[] = ['CANCELLED', 'CLOSED']

/** Live quantity on a line: ordered, less anything cancelled. */
function liveQty(fact: ReportLineFact): number {
  return Math.max(0, scaled(fact.qty, 3) - scaled(fact.qtyCancelled, 3))
}

/** Accepted, less anything sent back. What is actually sitting here. */
function heldQty(fact: ReportLineFact): number {
  return scaled(fact.qtyReceived, 3) - scaled(fact.qtyReturned, 3)
}

/**
 * The net value of `qtyScaled` (three decimal places) of this line, in pence, in
 * the line's OWN currency.
 *
 * Goes through the same `lineAmounts` the order screen and the bill match use,
 * so a part quantity is priced exactly as the whole line was - discount, tax
 * mode and all.
 */
function netPenceFor(fact: ReportLineFact, qtyScaled: number): number {
  if (qtyScaled <= 0) return 0
  return lineAmounts(
    {
      qty: qtyScaled / 1000,
      unitCost: fact.unitCost,
      discountPercent: fact.discountPercent,
      taxRatePercent: fact.taxRatePercent,
    },
    fact.taxMode,
  ).net
}

/**
 * Pence in the supplier's currency -> pence in the base currency.
 *
 * The order's own rate, stored when it was raised. It is an expectation rather
 * than a settlement - the bill carries the rate the books actually use - and the
 * screen says so, because a commitment figure that pretended to be exact would
 * be the more dishonest of the two.
 */
export function toBasePence(pence: number, fxRate: string | null | undefined): number {
  const rate = scaled(fxRate ?? '1', 8)
  if (rate <= 0) return pence
  return Math.round((pence * rate) / 100_000_000)
}

/** Every fact row's base-currency value for a quantity chosen by the caller. */
function valueOf(fact: ReportLineFact, qtyScaled: number): number {
  return toBasePence(netPenceFor(fact, qtyScaled), fact.fxRate)
}

// ---------------------------------------------------------------------------
// Committed spend - raised, not yet arrived
// ---------------------------------------------------------------------------

/**
 * What the site has promised suppliers and not yet received.
 *
 * Only orders that have actually been SENT count. An approved draft sitting in
 * the tray is a decision, not a commitment: nobody outside the building knows
 * about it, and nothing would turn up if everybody went home.
 */
export function commitmentBySupplier(facts: ReportLineFact[]): {
  suppliers: PoCommitmentSupplier[]
  total: string
  orderCount: number
} {
  const bySupplier = new Map<string, { name: string; pence: number; orders: Set<string>; lines: number }>()

  for (const fact of facts) {
    if (!fact.sentAt) continue
    if (COMMITMENT_ENDED.includes(fact.orderStatus)) continue
    const outstanding = liveQty(fact) - heldQty(fact)
    if (outstanding <= 0) continue

    const row = bySupplier.get(fact.supplierId) ?? {
      name: fact.supplierName,
      pence: 0,
      orders: new Set<string>(),
      lines: 0,
    }
    row.pence += valueOf(fact, outstanding)
    row.orders.add(fact.orderId)
    row.lines += 1
    bySupplier.set(fact.supplierId, row)
  }

  const suppliers = [...bySupplier.entries()]
    .map(([supplierId, row]) => ({
      supplierId,
      supplierName: row.name,
      value: fromPence(row.pence),
      orderCount: row.orders.size,
      lineCount: row.lines,
    }))
    .sort((a, b) => Number(b.value) - Number(a.value) || a.supplierName.localeCompare(b.supplierName))

  const total = suppliers.reduce((sum, s) => sum + scaled(s.value, 2), 0)
  const orders = new Set<string>()
  for (const row of bySupplier.values()) for (const id of row.orders) orders.add(id)

  return { suppliers, total: fromPence(total), orderCount: orders.size }
}

// ---------------------------------------------------------------------------
// The two accruals
// ---------------------------------------------------------------------------

/**
 * Goods here, invoice not.
 *
 * The classic purchasing accrual: what the site is going to be billed for and
 * has not been yet. Anything already sent back is taken off first - the supplier
 * will not be invoicing for that, and counting it makes the accrual too big
 * every time somebody returns a damaged one.
 *
 * A cancelled order is left out; a closed one is NOT. Closing an order is
 * somebody saying the goods business is finished, which says nothing at all
 * about whether the invoice ever turned up.
 */
export function receivedNotInvoiced(facts: ReportLineFact[]): { rows: PoAccrualRow[]; total: string } {
  return accrual(facts, (fact) => heldQty(fact) - scaled(fact.qtyInvoiced, 3))
}

/**
 * Invoice here, goods not.
 *
 * The other way round, and the more interesting of the two: a supplier has
 * billed for something nobody has seen. Worth a phone call rather than a
 * payment.
 */
export function invoicedNotReceived(facts: ReportLineFact[]): { rows: PoAccrualRow[]; total: string } {
  return accrual(facts, (fact) => scaled(fact.qtyInvoiced, 3) - heldQty(fact))
}

function accrual(
  facts: ReportLineFact[],
  gap: (fact: ReportLineFact) => number,
): { rows: PoAccrualRow[]; total: string } {
  const rows: PoAccrualRow[] = []
  let total = 0

  for (const fact of facts) {
    if (fact.orderStatus === 'CANCELLED') continue
    const qtyScaled = gap(fact)
    if (qtyScaled <= 0) continue
    const pence = valueOf(fact, qtyScaled)
    total += pence
    rows.push({
      orderId: fact.orderId,
      orderNumber: fact.orderNumber,
      supplierId: fact.supplierId,
      supplierName: fact.supplierName,
      description: fact.description,
      qty: (qtyScaled / 1000).toFixed(3),
      value: fromPence(pence),
    })
  }

  rows.sort((a, b) => Number(b.value) - Number(a.value) || a.orderNumber.localeCompare(b.orderNumber))
  return { rows, total: fromPence(total) }
}

// ---------------------------------------------------------------------------
// Late orders
// ---------------------------------------------------------------------------

/** Whole days from `from` to `to`, both plain YYYY-MM-DD days. Negative when
 *  `to` is the earlier of the two. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`)
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00.000Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/**
 * The date an order was promised for.
 *
 * The supplier's own expected date wins where there is one: it is the date they
 * agreed to, and chasing somebody against a date they never accepted is how a
 * supplier learns to ignore the emails. The date the site wanted is the fallback,
 * and an order with neither has no date to be late against - which is a gap in
 * the paperwork rather than a late delivery, and is reported as exactly that.
 */
export function dueDateOf(fact: {
  expectedDate: string | null
  requiredByDate: string | null
}): string | null {
  return fact.expectedDate ?? fact.requiredByDate ?? null
}

/** One row per late order, worst first, with what is still outstanding on it. */
export function overdueOrders(
  facts: ReportLineFact[],
  today: string,
  lastChased: Record<string, string | null> = {},
): PoOverdueOrder[] {
  const byOrder = new Map<string, PoOverdueOrder & { pence: number }>()

  for (const fact of facts) {
    if (!fact.sentAt) continue
    if (COMMITMENT_ENDED.includes(fact.orderStatus)) continue
    const outstanding = liveQty(fact) - heldQty(fact)
    if (outstanding <= 0) continue

    const due = dueDateOf(fact)
    if (!due) continue
    const daysLate = daysBetween(due, today)
    if (daysLate <= 0) continue

    const row = byOrder.get(fact.orderId) ?? {
      orderId: fact.orderId,
      orderNumber: fact.orderNumber,
      status: fact.orderStatus,
      supplierId: fact.supplierId,
      supplierName: fact.supplierName,
      dueDate: due,
      daysLate,
      outstandingLines: 0,
      outstandingValue: '0.00',
      lastChasedAt: lastChased[fact.orderId] ?? null,
      pence: 0,
    }
    row.outstandingLines += 1
    row.pence += valueOf(fact, outstanding)
    byOrder.set(fact.orderId, row)
  }

  return [...byOrder.values()]
    .map(({ pence, ...row }) => ({ ...row, outstandingValue: fromPence(pence) }))
    .sort((a, b) => b.daysLate - a.daysLate || a.orderNumber.localeCompare(b.orderNumber))
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** The month a day falls in, as `YYYY-MM`. */
export function monthKey(day: string): string {
  return day.slice(0, 7)
}

/** "Aug 2026", for a chart axis or a table row. */
export function monthLabel(key: string): string {
  const date = new Date(`${key}-01T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return key
  return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/**
 * Every month from `from` to `to` inclusive, even the empty ones.
 *
 * A spend chart that quietly skips a month with no invoices in it draws a
 * straight line through the quiet quarter and makes it look busy.
 */
export function monthsBetween(from: string, to: string): string[] {
  const start = new Date(`${monthKey(from)}-01T00:00:00.000Z`)
  const end = new Date(`${monthKey(to)}-01T00:00:00.000Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return []

  const out: string[] = []
  const cursor = new Date(start)
  // Twenty-five years of months is comfortably more than anybody wants on one
  // screen, and is the backstop against a typed date in the year 3000.
  while (cursor <= end && out.length < 300) {
    out.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return out
}

/**
 * Bills and credits, month by month, with the empty months filled in.
 *
 * Both halves are net of VAT, because that is the figure anybody comparing one
 * supplier against another actually wants and the only one the category cut can
 * also produce. The screen says so rather than leaving it to be guessed at.
 */
export function spendByMonth(
  bills: { month: string; value: string }[],
  credits: { month: string; value: string }[],
  from: string,
  to: string,
): PoSpendPoint[] {
  const billed = new Map<string, number>()
  const credited = new Map<string, number>()
  for (const row of bills) billed.set(row.month, (billed.get(row.month) ?? 0) + scaled(row.value, 2))
  for (const row of credits) credited.set(row.month, (credited.get(row.month) ?? 0) + scaled(row.value, 2))

  return monthsBetween(from, to).map((month) => {
    const gross = billed.get(month) ?? 0
    const credit = credited.get(month) ?? 0
    return {
      key: month,
      label: monthLabel(month),
      billed: fromPence(gross),
      credited: fromPence(credit),
      net: fromPence(gross - credit),
    }
  })
}

/**
 * The default window a spend report opens on: this month and the eleven before
 * it.
 *
 * A year is the span anybody comparing suppliers actually wants, and starting at
 * the beginning of a month rather than "this day last year" keeps the first
 * column from being a half month that looks like a collapse in trade.
 */
export function defaultSpendRange(today: string): { from: string; to: string } {
  const end = new Date(`${monthKey(today)}-01T00:00:00.000Z`)
  if (Number.isNaN(end.getTime())) return { from: today, to: today }
  const start = new Date(end)
  start.setUTCMonth(start.getUTCMonth() - 11)
  const from = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-01`
  return { from, to: today.slice(0, 10) }
}
