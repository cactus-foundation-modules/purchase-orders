import { getOrder, supplierPortalNote } from './db'
import { getPoConfigCached } from './config'
import { listPortalEvents } from './portal'
import { despatchedTotalsByLine, listShipmentsForOrder } from './shipments'
import { portalView, type PoPortalShipment, type PoPortalView } from './portal-view'

// The supplier's view of one order, gathered in one place.
//
// Both the page and the reply endpoint hand this exact object to the panel, so
// what a supplier sees after pressing a button is what they would see on a
// reload - built by the same code rather than by two renderings that agree with
// each other for now.
//
// SERVER ONLY. lib/portal-view.ts is the client-safe half: the shapes and the
// projection itself live there, because the panel imports them.

function despatchLines(lines: { description: string; qty: string; unit: string }[]) {
  return lines.map((line) => ({
    description: line.description,
    qty: String(Number(line.qty)),
    unit: line.unit,
  }))
}

/** What the supplier's panel is drawn from. Null when the order has gone. */
export async function buildPortalView(orderId: string): Promise<PoPortalView | null> {
  const order = await getOrder(orderId)
  if (!order) return null

  const [config, events, shipments, despatchedByLine, note] = await Promise.all([
    getPoConfigCached(),
    listPortalEvents(orderId, 20),
    listShipmentsForOrder(orderId),
    despatchedTotalsByLine(orderId),
    supplierPortalNote(orderId),
  ])

  // Their own drops, money-free and without the internal notes anybody here has
  // added to them.
  const theirs: PoPortalShipment[] = shipments.map((shipment) => ({
    id: shipment.id,
    number: shipment.number,
    despatchedDate: shipment.despatchedDate,
    carrier: shipment.carrier,
    trackingRef: shipment.trackingRef,
    lines: despatchLines(shipment.lines),
  }))

  return portalView(
    order,
    events.map((event) => ({
      id: event.id,
      kind: event.kind,
      createdAt: event.createdAt,
      summary: event.summary,
    })),
    {
      note,
      shipments: theirs,
      despatchedByLine,
      uploadsEnabled: config.portalUploadsEnabled,
      despatchEnabled: config.portalDespatchEnabled,
    },
  )
}
