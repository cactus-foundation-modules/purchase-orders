import { getPoConfigCached } from './config'
import { autoSettleForShopOrder } from './auto-settle-run'

// What this module does when a customer's order is marked Completed: nothing,
// unless the owner has asked for it, and then closes off the supplier's side of
// it if - and only if - the bill agrees with the purchase order to the penny
// (see lib/auto-settle.ts for the bar).
//
// Registered against shop's `shop.order-completed` point. The event carries
// plain strings and no shop types, which is why this file can exist: purchase
// orders is standalone and nothing here imports '@/modules/shop/...'.
//
// A hook is not a guarantee. The bill that arrives after the customer has their
// goods never meets this; the nightly sweep in the reorder cron does.

/** Shop's payload, restated locally. */
export type OrderCompletedEvent = {
  orderId: string
  orderNumber: string
}

/** Never throws: it runs at the end of a status change somebody else is making. */
export async function purchaseOrdersOrderCompletedObserver(event: OrderCompletedEvent): Promise<void> {
  try {
    // Cheapest possible first question, and the answer on every site that never
    // switches this on.
    const config = await getPoConfigCached()
    if (!config.autoSettleCompletedOrders) return
    await autoSettleForShopOrder(event.orderId)
  } catch (err) {
    console.error(`[purchase-orders] could not close off completed order ${event.orderNumber}`, err)
  }
}
