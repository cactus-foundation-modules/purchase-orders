import { getInstalledManifests } from '@/lib/modules/live-status'

// `purchase-orders.despatch-recorded` - another module gets told that a
// supplier has despatched the goods on one of our purchase orders.
//
// The reason this seam exists: the customer who is waiting for a drop-shipped
// order is shop's customer, not purchasing's. Purchasing knows the parcel has
// left the supplier and what its tracking is; shop knows whose order it is and
// how to tell them. So purchasing announces, generically, and whoever is
// listening listens. Purchase-orders never writes a shp_* table.
//
// OBSERVERS, not contributors, modelled on shop's `shop.order-paid`
// (shop/lib/order-paid-hooks.ts). Nothing an observer returns is stored or
// waited on, and one having a bad day cannot fail the inbox handler that
// recorded the despatch - by the time this runs the despatch is on the order
// and in the audit.
//
// Fired for a NEW despatch and for a MATERIAL change to one (a new tracking
// number or link, a delivery day or timeslot), and not for an email that
// changes nothing: lib/inbound-tracking.ts keeps a fingerprint of what was
// announced, written once every observer has taken it. Two runs reading the
// same email at the same moment may both announce it, so an observer must be
// idempotent (shop's is: the tracking is already on the order the second time).
//
// An observer THROWS for a passing failure (a busy order, a database blip) and
// returns quietly for a permanent refusal (switched off, a cancelled order,
// tracking already there). A throw leaves the despatch pending, and the
// half-hourly job announces it again (announcePendingDespatches). Only for a despatch on an order going straight to a
// customer: goods coming to our own warehouse are nobody else's news.
//
// Primitives only, so no observer imports this module. An observer restates
// the type locally.

export type DespatchRecordedEvent = {
  /** The despatch's own id here. Stable across updates, so an observer can
   *  tell a new parcel from news about one it has already seen. */
  despatchId: string
  /** 'new' the first time, 'update' for later news about the same parcel. */
  change: 'new' | 'update'
  purchaseOrderNumber: string
  /** Who the order was raised for, off po_orders.source_ref. Null for an order
   *  raised by hand or by a reorder run. */
  source: { module: 'shop'; orderId: string } | null
  /** What is in the parcel, as the customer's order lines: each despatched
   *  purchase order line with po_order_lines.source_order_item_id set. */
  lines: Array<{ sourceOrderItemId: string; qty: number }>
  carrier: string | null
  /** The parcel or consignment number, spaces out. */
  trackingNumber: string | null
  trackingUrl: string | null
  /** The code out of a follow-my-parcel link, where the email had one. The
   *  observer normalises it with its own rules; this is what was read. */
  trackingShortCode: string | null
  /** 'YYYY-MM-DD', when the email named the delivery day. */
  deliveryDate: string | null
  /** ['HH:MM', 'HH:MM'], when it named a window. */
  deliverySlot: [string, string] | null
}

export type DespatchRecordedObserver = (event: DespatchRecordedEvent) => Promise<void> | void

export const DESPATCH_RECORDED_POINT = 'purchase-orders.despatch-recorded'

type ExtensionPointEntry = { point: string; id: string }

/**
 * Every observer registered against the point, in manifest order.
 *
 * Read from the server registry, which keeps `serverOnly` entries: an observer
 * is database work and has no business in the map the public pages load.
 * Dynamic, because the generated registry imports this module's own screens,
 * which reach back here, and a static edge closes a cycle a production build
 * can fail on.
 */
async function gatherObservers(): Promise<DespatchRecordedObserver[]> {
  const { moduleServerExtensionPointComponents } = await import('@/lib/modules/extension-points.server')
  const fns = (moduleServerExtensionPointComponents as Record<string, Record<string, unknown>>)[DESPATCH_RECORDED_POINT] ?? {}
  if (Object.keys(fns).length === 0) return []
  const gathered: DespatchRecordedObserver[] = []
  for (const mod of await getInstalledManifests()) {
    const manifest = mod.manifest as { extensionPoints?: ExtensionPointEntry[] } | null
    for (const entry of manifest?.extensionPoints ?? []) {
      if (entry.point !== DESPATCH_RECORDED_POINT) continue
      const fn = fns[entry.id]
      if (typeof fn === 'function') gathered.push(fn as DespatchRecordedObserver)
    }
  }
  return gathered
}

/**
 * Tell every registered observer about a despatch.
 *
 * Never throws, never rejects. An observer that throws is logged and the next
 * one still runs. On a site with nobody listening this is one memoised read of
 * the installed manifests and nothing else. True when every observer took it
 * without throwing - the caller marks the despatch announced only then.
 */
export async function notifyDespatchRecorded(
  event: DespatchRecordedEvent,
  observers?: readonly DespatchRecordedObserver[],
): Promise<boolean> {
  let list: readonly DespatchRecordedObserver[]
  try {
    list = observers ?? (await gatherObservers())
  } catch (error) {
    console.error('[purchase-orders.despatch-recorded] could not gather observers', error)
    return false
  }
  let delivered = true
  for (const observe of list) {
    try {
      await observe(event)
    } catch (error) {
      delivered = false
      console.error(`[purchase-orders.despatch-recorded] observer failed for ${event.purchaseOrderNumber}`, error)
    }
  }
  return delivered
}
