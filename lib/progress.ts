import { Prisma } from '@prisma/client'

// Received, invoiced and returned are DERIVED, never counted twice.
//
// There is no qty_received / qty_invoiced / qty_returned column on
// po_order_lines. Every one of those figures is a SUM over the child table that
// actually holds the fact, expressed here once so that the order screen, the
// receiving screen, the three-way match and the reports can never disagree with
// each other about how much of a line has turned up.
//
// A stored counter would be faster and would drift the first time somebody
// deletes a receipt. Purchase orders are low volume; the join is cheap; and if
// it ever does bite, this is the one place to add an index or a materialised
// counter.

/**
 * Correlated subqueries giving the three derived quantities for an order line.
 * Interpolate after selecting from `po_order_lines` under the alias `l`.
 */
export const LINE_PROGRESS_SQL = Prisma.sql`
  COALESCE((
    SELECT SUM(rl."qty_accepted") FROM "po_receipt_lines" rl WHERE rl."order_line_id" = l."id"
  ), 0) AS "qty_received",
  COALESCE((
    SELECT SUM(bl."qty") FROM "po_bill_lines" bl WHERE bl."order_line_id" = l."id"
  ), 0) AS "qty_invoiced",
  COALESCE((
    SELECT SUM(tl."qty") FROM "po_return_lines" tl WHERE tl."order_line_id" = l."id"
  ), 0) AS "qty_returned"
`

/** What a line is still expecting: ordered, less anything cancelled, less what has arrived. */
export function outstandingQty(qty: string, qtyCancelled: string, qtyReceived: string): number {
  return Math.max(0, Number(qty) - Number(qtyCancelled) - Number(qtyReceived))
}

export type LineProgress = {
  qty: string
  qtyCancelled: string
  qtyReceived: string
}

/**
 * Where a purchase order has got to, judged purely off its lines.
 *
 * `RECEIVED` when every live line's accepted quantity has met what was ordered
 * less anything cancelled; `PART_RECEIVED` when anything at all has arrived but
 * something is still short; otherwise nothing - the order keeps whatever status
 * it already had. Closing is a human decision (or, later, an automatic one once
 * a received order is fully invoiced with no open return), never this function's.
 */
export function receiptStatus(lines: LineProgress[]): 'RECEIVED' | 'PART_RECEIVED' | null {
  const live = lines.filter((l) => Number(l.qty) - Number(l.qtyCancelled) > 0)
  if (live.length === 0) return null

  const anyReceived = lines.some((l) => Number(l.qtyReceived) > 0)
  if (!anyReceived) return null

  const allMet = live.every(
    (l) => Number(l.qtyReceived) >= Number(l.qty) - Number(l.qtyCancelled),
  )
  return allMet ? 'RECEIVED' : 'PART_RECEIVED'
}
