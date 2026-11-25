import { prisma } from '@/lib/db/prisma'
import { recordAudit } from './audit'
import { readShopOrder, shipToFromShopOrder } from './from-order'
import type { PoShipTo } from './types'

// What this module does when somebody changes the delivery details on a customer
// order: carries the change onto any drop-ship purchase order that has not yet
// gone to the supplier, so they are never sent the address the customer has
// since corrected.
//
// Registered against shop's `shop.order-delivery-changed` point. The event
// carries plain strings and no shop types, so nothing here imports
// '@/modules/shop/...'; the customer order is read through `readShopOrder`.
//
// "Not yet gone" is DRAFT, AWAITING_APPROVAL and APPROVED. From SENT onward the
// supplier holds a copy this module cannot recall, and rewriting the record of
// what they were sent would only make it lie.

/** Shop's payload, restated locally. Structural, so it stays compatible. */
export type OrderDeliveryChangedEvent = {
  orderId: string
  orderNumber: string
  addressChanged: boolean
  instructionsChanged: boolean
}

/** Statuses at which the supplier has not yet been sent the order. */
export const UNSENT_STATUSES = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'] as const

/**
 * The ship-to a purchase order should carry after the customer's details change.
 *
 * Only what changed is replaced. The address change covers the label (company or
 * person), the contact, the phone and the address lines, which the shop edits as
 * one block; the instructions are separate. Anything a person typed into the
 * other box on the purchase order since it was drafted is left exactly as they
 * left it.
 */
export function mergeShipTo(
  current: PoShipTo,
  fresh: PoShipTo,
  changed: { addressChanged: boolean; instructionsChanged: boolean },
): PoShipTo {
  return {
    name: changed.addressChanged ? fresh.name : current.name,
    contact: changed.addressChanged ? fresh.contact : current.contact,
    phone: changed.addressChanged ? fresh.phone : current.phone,
    address: changed.addressChanged ? fresh.address : current.address,
    instructions: changed.instructionsChanged ? fresh.instructions : current.instructions,
  }
}

/**
 * Bring every unsent drop-ship purchase order for a customer order up to date.
 * Returns how many were rewritten. Pure SQL plus one read of the customer order.
 */
export async function syncShipToFromShopOrder(event: OrderDeliveryChangedEvent): Promise<number> {
  if (!event.addressChanged && !event.instructionsChanged) return 0

  const rows = await prisma.$queryRaw<{ id: string; number: string; ship_to: unknown }[]>`
    SELECT o."id", o."number", o."ship_to"
      FROM "po_orders" o
     WHERE o."source_kind" = 'FROM_ORDER'
       AND o."source_ref"->>'orderId' = ${event.orderId}
       AND o."ship_to_kind" = 'CUSTOMER'
       AND o."status" = ANY(${[...UNSENT_STATUSES]}::text[])
  `
  if (rows.length === 0) return 0

  const shopOrder = await readShopOrder(event.orderId)
  if (!shopOrder) return 0
  const fresh = shipToFromShopOrder(shopOrder)

  let updated = 0
  for (const row of rows) {
    const current = asShipTo(row.ship_to)
    const next = mergeShipTo(current, fresh, event)
    if (JSON.stringify(next) === JSON.stringify(current)) continue

    // The status is re-checked in the UPDATE itself: an order sent between the
    // read above and this write must not have its record rewritten.
    const count = await prisma.$executeRaw`
      UPDATE "po_orders"
         SET "ship_to" = ${JSON.stringify(next)}::jsonb, "updated_at" = now()
       WHERE "id" = ${row.id} AND "status" = ANY(${[...UNSENT_STATUSES]}::text[])
    `
    if (count === 0) continue
    updated += 1
    await recordAudit('order', row.id, 'order.ship-to-synced', {
      shopOrder: event.orderNumber,
      addressChanged: event.addressChanged,
      instructionsChanged: event.instructionsChanged,
      from: current,
      to: next,
    })
  }
  return updated
}

function asShipTo(value: unknown): PoShipTo {
  const raw = (value ?? {}) as Partial<PoShipTo>
  const address = (raw.address ?? {}) as Partial<PoShipTo['address']>
  return {
    name: raw.name ?? '',
    contact: raw.contact ?? '',
    phone: raw.phone ?? '',
    address: {
      line1: address.line1 ?? '',
      line2: address.line2 ?? '',
      city: address.city ?? '',
      region: address.region ?? '',
      postcode: address.postcode ?? '',
      country: address.country ?? '',
    },
    instructions: raw.instructions ?? '',
  }
}

/** Never throws: it runs at the end of a save somebody else is making. */
export async function purchaseOrdersOrderDeliveryChangedObserver(event: OrderDeliveryChangedEvent): Promise<void> {
  try {
    await syncShipToFromShopOrder(event)
  } catch (err) {
    console.error(`[purchase-orders] could not update delivery details for order ${event.orderNumber}`, err)
  }
}
