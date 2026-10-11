import { getInstalledManifests } from '@/lib/modules/live-status'

// `purchase-orders.sent` - another module gets told that a purchase order has
// gone to a supplier for the first time.
//
// The reason this seam exists: the customer waiting on a bought-in order is
// shop's customer, not purchasing's. Purchasing knows the goods have been
// ordered; shop knows whose order it is and how to tell them. So purchasing
// announces, generically, and whoever is listening listens. Purchase-orders
// never writes a shp_* table.
//
// OBSERVERS, not contributors, modelled on `purchase-orders.despatch-recorded`
// (lib/despatch-hooks.ts). Nothing an observer returns is stored or waited on,
// and one having a bad day cannot fail the send that triggered it - by the time
// this runs the email has gone and the send is on the order and in the audit.
//
// Fired once, for the FIRST send of an order raised for a customer order; an
// amendment is not news. An observer must be idempotent. Primitives only, so no
// observer imports this module: it restates the type locally.

export type PurchaseOrderSentEvent = {
  purchaseOrderNumber: string
  /** Who the order was raised for, off po_orders.source_ref. Null for an order
   *  raised by hand or by a reorder run. */
  source: { module: 'shop'; orderId: string } | null
}

export type PurchaseOrderSentObserver = (event: PurchaseOrderSentEvent) => Promise<unknown> | unknown

export const PURCHASE_ORDER_SENT_POINT = 'purchase-orders.sent'

type ExtensionPointEntry = { point: string; id: string }

/** Every observer registered against the point, in manifest order. Read from
 *  the server registry and imported dynamically for the same reasons as
 *  lib/despatch-hooks.ts. */
async function gatherObservers(): Promise<PurchaseOrderSentObserver[]> {
  const { moduleServerExtensionPointComponents } = await import('@/lib/modules/extension-points.server')
  const fns = (moduleServerExtensionPointComponents as Record<string, Record<string, unknown>>)[PURCHASE_ORDER_SENT_POINT] ?? {}
  if (Object.keys(fns).length === 0) return []
  const gathered: PurchaseOrderSentObserver[] = []
  for (const mod of await getInstalledManifests()) {
    const manifest = mod.manifest as { extensionPoints?: ExtensionPointEntry[] } | null
    for (const entry of manifest?.extensionPoints ?? []) {
      if (entry.point !== PURCHASE_ORDER_SENT_POINT) continue
      const fn = fns[entry.id]
      if (typeof fn === 'function') gathered.push(fn as PurchaseOrderSentObserver)
    }
  }
  return gathered
}

/** The shop order a source_ref names, or null. */
export function shopSourceOf(sourceRef: Record<string, unknown> | null): PurchaseOrderSentEvent['source'] {
  const orderId = sourceRef?.orderId
  return typeof orderId === 'string' && orderId ? { module: 'shop', orderId } : null
}

/**
 * Tell every registered observer a purchase order has been sent.
 *
 * Never throws, never rejects. An observer that throws is logged and the next
 * one still runs. On a site with nobody listening this is one memoised read of
 * the installed manifests and nothing else.
 */
export async function notifyPurchaseOrderSent(
  event: PurchaseOrderSentEvent,
  observers?: readonly PurchaseOrderSentObserver[],
): Promise<void> {
  let list: readonly PurchaseOrderSentObserver[]
  try {
    list = observers ?? (await gatherObservers())
  } catch (error) {
    console.error('[purchase-orders.sent] could not gather observers', error)
    return
  }
  for (const observe of list) {
    try {
      await observe(event)
    } catch (error) {
      console.error(`[purchase-orders.sent] observer failed for ${event.purchaseOrderNumber}`, error)
    }
  }
}
