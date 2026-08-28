import { prisma } from '@/lib/db/prisma'
import { getCapabilities } from './capabilities'
import { getPoConfigCached } from './config'
import { raisePurchaseOrdersFromShopOrder } from './from-order-run'
import { reportAutoDraft } from './auto-draft-report'
import type { FromOrderRaised } from './from-order-run'

// The catch-up pass, and the reason the hook on its own is not enough.
//
// Four ways a paid order drafts nothing: the payment webhook died mid-flight,
// this module was installed after the order was paid, the setting was switched
// on after the order was paid, or the shop is older than the `shop.order-paid`
// point and never had anything to announce to. None of them is exotic and all
// four end the same way - a customer waiting for goods nobody has ordered.
//
// Both reads are raw SQL against shp_* behind `hasCatalogue`, exactly as
// lib/from-order.ts does, and both degrade to "no shop, nothing to do" rather
// than throwing. Nothing here imports '@/modules/shop/...'.

/**
 * How far back a sweep will look.
 *
 * A backstop rather than a migration. Without it, the first run after somebody
 * switches the setting on would draft purchase orders for every order the shop
 * has ever taken - including the ones fulfilled and forgotten two years ago,
 * which is a very expensive way to find out what this feature does. Anything
 * older than this wants the button on the order, pressed by somebody who has
 * thought about it.
 */
const SWEEP_DAYS = 7

export type PaidSweepResult = {
  /** Orders that had been paid for and had nothing raised against them. */
  considered: number
  raised: Array<{ orderNumber: string; pos: FromOrderRaised[] }>
  /** Orders the run turned away, with the sentence it gave. */
  refused: Array<{ orderNumber: string; reason: string }>
  /**
   * Live purchase orders whose customer order has since been cancelled or
   * refunded - the case automation creates and the button did not. Reported,
   * never acted on: goods may already be on their way, and cancelling a supplier
   * order is a decision with a phone call in it.
   */
  orphaned: Array<{ number: string; supplierName: string; orderNumber: string; orderStatus: string }>
  /** Set where the sweep did not run at all, and why. */
  skipped: string | null
}

const NOTHING: PaidSweepResult = { considered: 0, raised: [], refused: [], orphaned: [], skipped: null }

/**
 * Draft for every paid order that has nothing raised against it, and report the
 * purchase orders left stranded by a refund.
 *
 * Run from the nightly cron beside the reorder job. Gated on the same setting as
 * the hook, so a site that has not asked for any of this never sweeps and never
 * reads another module's tables to find out it had nothing to do.
 */
export async function runPaidSweep(): Promise<PaidSweepResult> {
  const config = await getPoConfigCached()
  if (!config.autoDraftFromPaidOrders) {
    return { ...NOTHING, skipped: 'Drafting from paid orders is switched off.' }
  }

  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) return { ...NOTHING, skipped: 'There is no shop on this site.' }

  const [pending, orphaned] = await Promise.all([paidWithNothingRaised(), liveOrdersForDeadShopOrders()])

  const result: PaidSweepResult = { considered: pending.length, raised: [], refused: [], orphaned, skipped: null }

  for (const order of pending) {
    // One at a time and never in parallel: each raise takes numbers off a
    // sequence and writes several rows, and a sweep that fans out is a sweep
    // that fights the site it is running on.
    const run = await raisePurchaseOrdersFromShopOrder({ orderId: order.id, userId: null })
    if (run.ordersCreated.length > 0) result.raised.push({ orderNumber: order.orderNumber, pos: run.ordersCreated })
    if (run.refused) result.refused.push({ orderNumber: order.orderNumber, reason: run.refused })
    await reportAutoDraft(order.orderNumber, run)
  }

  return result
}

/**
 * Paid, still live, recent, and with no purchase order standing against it.
 *
 * The NOT EXISTS is the same question `livePos` asks in JS after the fact, moved
 * into the query because this one runs over every recent order rather than over
 * one. A CANCELLED purchase order deliberately does not count: cancelling one is
 * a decision to buy this differently, and it must not lock the order out for
 * ever.
 */
async function paidWithNothingRaised(): Promise<Array<{ id: string; orderNumber: string }>> {
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT o."id", o."order_number"
        FROM "shp_orders" o
       WHERE o."payment_status" = 'PAID'
         AND o."status" NOT IN ('CANCELLED', 'REFUNDED')
         AND o."paid_at" IS NOT NULL
         AND o."paid_at" >= now() - make_interval(days => ${SWEEP_DAYS})
         AND NOT EXISTS (
               SELECT 1 FROM "po_orders" p
                WHERE p."source_kind" = 'FROM_ORDER'
                  AND p."source_ref"->>'orderId' = o."id"
                  AND p."status" <> 'CANCELLED'
             )
       ORDER BY o."paid_at" ASC
    `
    return rows.map((r) => ({ id: r.id as string, orderNumber: r.order_number as string }))
  } catch {
    // hasCatalogue only proves shp_products is there. A shop without the columns
    // this asks for degrades to "nothing to sweep", which is the same answer a
    // site with no shop gets.
    return []
  }
}

/**
 * Purchase orders still live against a customer order that has since been
 * cancelled or refunded.
 *
 * Only worth asking because of automation. Somebody who pressed Raise knows
 * they raised it and will see the refund; a draft that appeared on its own has
 * nobody watching it, and the first anybody would know is a supplier delivering
 * goods for an order that was refunded a fortnight ago.
 *
 * Not time-limited, unlike the sweep above: an order refunded three months after
 * it was placed is exactly the case worth catching, and the query is cheap
 * because it starts from purchase orders rather than from every order the shop
 * has ever taken.
 */
async function liveOrdersForDeadShopOrders(): Promise<PaidSweepResult['orphaned']> {
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT p."number", p."status", o."order_number", o."status" AS "order_status",
             s."name" AS "supplier_name"
        FROM "po_orders" p
        JOIN "shp_orders" o ON o."id" = p."source_ref"->>'orderId'
        LEFT JOIN "po_suppliers" s ON s."id" = p."supplier_id"
       WHERE p."source_kind" = 'FROM_ORDER'
         AND p."status" NOT IN ('CANCELLED', 'CLOSED')
         AND o."status" IN ('CANCELLED', 'REFUNDED')
       ORDER BY p."created_at" ASC
    `
    return rows.map((r) => ({
      number: r.number as string,
      supplierName: (r.supplier_name as string | null) ?? 'A supplier no longer on your list',
      orderNumber: r.order_number as string,
      orderStatus: r.order_status as string,
    }))
  } catch {
    return []
  }
}
