import { getOrder, supplierPortalNote } from './db'
import { listBillableLines } from './bills'
import { getPoConfigCached } from './config'
import { listOursPortalEvents, listPortalEvents } from './portal'
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

  const [config, events, ours, shipments, despatchedByLine, note] = await Promise.all([
    getPoConfigCached(),
    listPortalEvents(orderId, 20),
    listOursPortalEvents(orderId, 20),
    listShipmentsForOrder(orderId),
    despatchedTotalsByLine(orderId),
    supplierPortalNote(orderId),
  ])

  // What has already been billed, line by line, and only where the supplier can
  // do anything with the answer. A site with the invoice switch off gets no
  // extra query for a form nobody will see.
  const invoicedByLine: Record<string, string> = {}
  if (config.portalInvoicesEnabled) {
    for (const line of await listBillableLines(orderId)) {
      invoicedByLine[line.orderLineId] = line.qtyInvoiced
    }
  }

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
      ours,
      shipments: theirs,
      despatchedByLine,
      uploadsEnabled: config.portalUploadsEnabled,
      despatchEnabled: config.portalDespatchEnabled,
      // Both switches, because an invoice arrives as a file: a site that has
      // turned uploads off cannot take one however the invoice switch is set.
      invoicesEnabled: config.portalInvoicesEnabled && config.portalUploadsEnabled,
      invoicedByLine,
    },
  )
}
