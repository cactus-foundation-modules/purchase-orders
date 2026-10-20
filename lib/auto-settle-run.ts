import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getCapabilities } from './capabilities'
import { getPoConfigCached } from './config'
import { getOrder, setOrderStatus } from './db'
import { approveDraftBill, listBillsForOrder, openReturnCount, orderInvoicedLines, refreshBillMatch } from './bills'
import { sendBillToBooks } from './book-handoff'
import { closeOutcome } from './billing'
import { recordAudit } from './audit'
import { AUTO_SETTLE_STATUSES, autoSettleVerdict, type SettleBill } from './auto-settle'
import type { PoMatchStatus } from './types'

// The database half of closing off the supplier's side of a completed customer
// order. The decision itself is lib/auto-settle.ts; this reads the facts, acts
// on a yes, and writes down what it did.
//
// Reached two ways, and both matter. Shop announces `shop.order-completed` the
// moment the order is marked Completed, which covers the bill that was already
// waiting. The nightly sweep covers everything the announcement cannot: the
// invoice that only arrives AFTER the customer has their goods (the usual
// order of events), a shop older than the point, a dropped call.
//
// Nothing here imports '@/modules/shop/...'. The customer order is read by raw
// SQL behind a try/catch, exactly as lib/paid-sweep.ts does.

/** How far back the sweep looks, counted from when the purchase order was made.
 *  A backstop: switching this on must not go and approve invoices on orders
 *  finished a year ago that somebody left in draft for a reason. */
const SWEEP_DAYS = 120

const REASON = 'The customer order was completed and the supplier’s bill agreed with this order to the penny.'

export type AutoSettled = { number: string; billsApproved: number }

/**
 * Close off one purchase order if the decision says so. Returns what it did, or
 * null where it left the order alone (the ordinary answer, not a failure).
 */
async function settleOne(orderId: string): Promise<AutoSettled | null> {
  const order = await getOrder(orderId)
  if (!order || !AUTO_SETTLE_STATUSES.includes(order.status)) return null

  const summaries = await listBillsForOrder(orderId)
  // The match on a draft is as old as the last time it was computed, and a
  // delivery since may have changed what it says. Recomputed here so the
  // decision is made on what is true now.
  const bills: SettleBill[] = []
  for (const bill of summaries) {
    let matchStatus: PoMatchStatus = bill.matchStatus
    if (bill.status === 'DRAFT') matchStatus = (await refreshBillMatch(bill.id))?.status ?? bill.matchStatus
    bills.push({ id: bill.id, status: bill.status, total: bill.total, matchStatus })
  }

  const [lines, openReturns] = await Promise.all([orderInvoicedLines(orderId), openReturnCount(orderId)])
  const verdict = autoSettleVerdict({
    orderStatus: order.status,
    orderTotal: order.total,
    dropships: order.supplierDropships,
    lines,
    openReturns,
    bills,
  })
  if (!verdict.ok) return null

  const config = await getPoConfigCached()
  let approved = 0
  for (const id of verdict.approve) {
    // False means somebody else got there first (a person, or the other of the
    // two triggers). Stop rather than close on a state this run did not see:
    // the next run starts from what is actually there.
    if (!(await approveDraftBill(id))) return null
    approved += 1
    await recordAudit('bill', id, 'bill.approve', {
      to: 'APPROVED',
      auto: true,
      note: 'Approved automatically: the customer order was completed and this bill agreed with the order.',
    })
    if (config.postApprovedBillsToBooks) {
      // The bill is approved either way; a set of books having a bad day is
      // stored on the bill and offered again on its screen, as for a person.
      await sendBillToBooks(id).catch((error) => {
        console.error('[purchase-orders] could not hand an auto-approved bill to the books', { id, error })
      })
    }
  }

  // The same rule again, now that nothing is unsettled, and against the order as
  // it stands: a return raised in the last second still stops it.
  const [after, returnsNow] = await Promise.all([getOrder(orderId), openReturnCount(orderId)])
  if (!after || !AUTO_SETTLE_STATUSES.includes(after.status)) return null
  const judged = after.status === 'PENDING_CLOSE' ? 'RECEIVED' : after.status
  if (closeOutcome(judged, await orderInvoicedLines(orderId), returnsNow, 0, after.supplierDropships) !== 'CLOSED') {
    return { number: order.number, billsApproved: approved }
  }

  await setOrderStatus(orderId, 'CLOSED', { closeReason: REASON }, null)
  await recordAudit('order', orderId, 'order.auto-closed', {
    reason: REASON,
    billsApproved: approved || undefined,
    auto: true,
  })
  return { number: order.number, billsApproved: approved }
}

/** Purchase orders raised for this customer order that are in a state to close.
 *  The customer order's status is checked again here, on the row, so an event
 *  that arrived for an order since put back to Shipped does nothing. */
async function candidatesFor(shopOrderId: string | null): Promise<string[]> {
  try {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p."id"
        FROM "po_orders" p
        JOIN "shp_orders" s ON s."id" = p."source_ref"->>'orderId'
       WHERE p."source_kind" = 'FROM_ORDER'
         AND s."status" = 'COMPLETED'
         AND p."status" = ANY(${AUTO_SETTLE_STATUSES as unknown as string[]}::text[])
         AND EXISTS (SELECT 1 FROM "po_bills" b WHERE b."order_id" = p."id" AND b."status" <> 'VOID')
         ${shopOrderId
           ? Prisma.sql`AND s."id" = ${shopOrderId}`
           : Prisma.sql`AND p."created_at" >= now() - make_interval(days => ${SWEEP_DAYS}::int4)`}
       ORDER BY p."created_at" ASC
    `
    return rows.map((r) => r.id)
  } catch {
    // No shop, or one too old to have the columns.
    return []
  }
}

async function run(shopOrderId: string | null): Promise<AutoSettled[]> {
  const config = await getPoConfigCached()
  if (!config.autoSettleCompletedOrders) return []
  if (!(await getCapabilities()).hasCatalogue) return []

  const done: AutoSettled[] = []
  // One at a time: each one approves money and writes to the books.
  for (const id of await candidatesFor(shopOrderId)) {
    try {
      const settled = await settleOne(id)
      if (settled) done.push(settled)
    } catch (error) {
      console.error('[purchase-orders] could not auto-settle a completed order', { id, error })
    }
  }
  return done
}

/** The customer order has just been completed. */
export function autoSettleForShopOrder(shopOrderId: string): Promise<AutoSettled[]> {
  return run(shopOrderId)
}

/** Nightly: every recent purchase order whose customer order is Completed. */
export function runAutoSettleSweep(): Promise<AutoSettled[]> {
  return run(null)
}
