import { getPoConfigCached } from './config'
import { raisePurchaseOrdersFromShopOrder } from './from-order-run'
import { reportAutoDraft } from './auto-draft-report'

// What this module does when a customer order is paid for: nothing, unless the
// owner has asked for it, and then exactly what pressing Raise on that order
// would have done.
//
// Registered against shop's `shop.order-paid` point. The event carries plain
// strings and no shop types, which is the whole reason this file can exist:
// purchase-orders is standalone, `requiresModules` is `[]`, and nothing here
// imports '@/modules/shop/...' - that path does not exist at build time on an
// install with no shop. An `orderId` is all it needs; `readShopOrder` already
// reads the customer order by raw SQL behind `hasCatalogue`.
//
// A shop older than the point never gathers this and it simply never runs. The
// catch-up sweep is what covers that, and covers a dropped webhook besides.

/** Shop's payload, restated locally. Structural, so it stays compatible without
 *  a dependency: shop passes more than this and nothing here minds. */
export type OrderPaidEvent = {
  orderId: string
  orderNumber: string
  paymentMethod: string
  clearedManually: boolean
}

/**
 * Draft the purchase orders for an order that has just been paid for.
 *
 * DRAFTS ONLY. Nothing is approved, nothing is sent, no supplier hears anything
 * - the same run the button uses, with no session behind it.
 *
 * Never throws. Shop already swallows an observer's failure, but this is the
 * end of a payment webhook and a module that leans on somebody else's catch is
 * a module one refactor away from failing payments.
 */
export async function purchaseOrdersOrderPaidObserver(event: OrderPaidEvent): Promise<void> {
  try {
    // Cheapest possible first question, and the answer on every site that never
    // switches this on. One cached read, no writes, nothing else runs.
    const config = await getPoConfigCached()
    if (!config.autoDraftFromPaidOrders) return

    const result = await raisePurchaseOrdersFromShopOrder({ orderId: event.orderId, userId: null })

    // Somebody has to be told when an automatic run could not buy something.
    // The button's caller reads that off the screen; this one has no screen.
    await reportAutoDraft(event.orderNumber, result)
  } catch (err) {
    console.error(`[purchase-orders] could not draft for paid order ${event.orderNumber}`, err)
  }
}
