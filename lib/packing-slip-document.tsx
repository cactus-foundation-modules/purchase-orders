import type { ReactNode } from 'react'
import { Render } from '@puckeditor/core/rsc'
import type { Data } from '@puckeditor/core'
import { prisma } from '@/lib/db/prisma'
import { getSiteUrl } from '@/lib/config/env'
import { resolveThemeLayout } from '@/lib/layout/resolveThemeLayout'
import { renderDocumentRunningFooter } from '@/lib/documents/footer'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { getShipment } from '@/modules/purchase-orders/lib/shipments'
import { buyerParty } from '@/modules/purchase-orders/lib/document'
import { injectPoPsDocContext, type PoPsDocContext } from '@/modules/purchase-orders/lib/packing-slip-context'
import { docPageSetupFromLayout, type DocPageSetup } from '@/modules/purchase-orders/lib/doc-page-settings'
import { PO_PACKING_SLIP_FALLBACK_DATA } from '@/modules/purchase-orders/lib/starterLayouts'

// Rendering the packing slip. The same two surfaces the order and the returns
// note have:
//
//  - /purchase-order/packing-slip/<number>   the page somebody opens
//  - the PDF                                 a headless browser printing it
//
// with one addition neither of the others has: the SUPPLIER opens this one too,
// through their own portal link, because they are the ones printing it and
// putting it in the box.
//
// SERVER ONLY. The context types and the sample live in
// lib/packing-slip-context.ts, which is client-safe because the blocks import it.

const LAYOUT_TYPE = 'purchasePackingSlip'
const MODULE_NAME = 'purchase-orders'

/** Our customer's own order number, where this purchase order was raised off
 *  one. Read off the order's source_ref rather than joined out of the shop -
 *  this module holds no key into another module's tables, and the number was
 *  snapshotted there precisely so nobody has to. */
function customerReferenceFrom(sourceRef: Record<string, unknown> | null): string {
  const value = sourceRef?.orderNumber
  return typeof value === 'string' ? value : ''
}

/** Everything the slip's blocks need, gathered once. Null when the despatch is
 *  not there any more, which the callers turn into a 404. */
export async function loadPoPackingSlipContext(
  shipmentId: string,
  opts?: { print?: boolean },
): Promise<PoPsDocContext | null> {
  const shipment = await getShipment(shipmentId)
  if (!shipment) return null

  const order = await getOrder(shipment.orderId)
  if (!order) return null

  const [config, buyer, site] = await Promise.all([
    getPoConfigCached(),
    buyerParty(),
    prisma.siteConfig
      .findUnique({ where: { id: 'singleton' }, select: { siteName: true, logoMediaId: true } })
      .catch(() => null),
  ])

  const logo = site?.logoMediaId
    ? await prisma.media.findUnique({ where: { id: site.logoMediaId }, select: { url: true } }).catch(() => null)
    : null

  // How much of each line was ordered in the first place, so a slip can say
  // "8 of 12" rather than leaving somebody to count a box against an order they
  // are not holding.
  const orderedByLine = new Map(
    order.lines.map((line) => [line.id, (Number(line.qty) - Number(line.qtyCancelled)).toFixed(3)]),
  )

  // Whether anything is still to come. Counted across the whole order rather
  // than off this despatch alone: a second box on the same day makes the first
  // one complete, and a slip that still said "more to follow" would send
  // somebody looking for a lorry that has already been.
  const despatchedByLine = new Map<string, number>()
  for (const line of order.lines) despatchedByLine.set(line.id, 0)
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT sl."order_line_id", SUM(sl."qty") AS "qty"
      FROM "po_shipment_lines" sl
      JOIN "po_shipments" d ON d."id" = sl."shipment_id"
     WHERE d."order_id" = ${order.id}
     GROUP BY sl."order_line_id"
  `
  for (const row of rows) despatchedByLine.set(row.order_line_id as string, Number(row.qty ?? 0))
  const partial = order.lines.some((line) => {
    const wanted = Number(line.qty) - Number(line.qtyCancelled)
    return wanted - (despatchedByLine.get(line.id) ?? 0) > 0.0005
  })

  return {
    slip: {
      number: shipment.number,
      despatchedDate: shipment.despatchedDate,
      orderNumber: order.number,
      orderDate: order.raisedDate,
      customerReference: customerReferenceFrom(order.sourceRef),
      carrier: shipment.carrier ?? '',
      trackingRef: shipment.trackingRef ?? '',
      notes: shipment.notes ?? '',
      partial,
      lines: shipment.lines.map((line) => ({
        id: line.id,
        description: line.description,
        ourSku: line.ourSku,
        supplierSku: line.supplierSku,
        qty: line.qty,
        unit: line.unit,
        qtyOrdered: orderedByLine.get(line.orderLineId) ?? line.qty,
      })),
    },
    buyer,
    // The order's own delivery address, which on a drop-shipped order is the
    // customer's - and is exactly where this box is going.
    shipTo: {
      name: order.shipTo.name,
      contact: order.shipTo.contact,
      phone: order.shipTo.phone,
      addressLines: [
        order.shipTo.address?.line1,
        order.shipTo.address?.line2,
        order.shipTo.address?.city,
        order.shipTo.address?.region,
        order.shipTo.address?.postcode,
      ]
        .map((line) => (line ?? '').trim())
        .filter(Boolean),
      country: (order.shipTo.address?.country ?? '').trim(),
      instructions: order.shipTo.instructions ?? '',
    },
    site: {
      name: site?.siteName ?? '',
      logoUrl: logo?.url ?? null,
      url: getSiteUrl(),
    },
    copy: {
      heading: config.packingSlipWording.heading,
      intro: config.packingSlipWording.intro,
      terms: config.packingSlipWording.terms,
      // The footer note is the ORDER's: it is a business's own registration
      // strip, printed at the foot of everything it sends, and asking somebody
      // to type it three times would be asking for the three to disagree.
      footerNote: config.wording.footerNote,
    },
    print: opts?.print ?? false,
  }
}

/**
 * The slip as a React tree: the published `purchasePackingSlip` layout with the
 * context injected into its part-blocks, or the standard starter's own blocks
 * when nothing has been published.
 *
 * Never refuses, for the same reason the order and the returns note never do:
 * somebody is standing beside a pallet with a roll of tape, and "ask an
 * administrator to publish a layout" is not an answer they can act on.
 */
export async function renderPoPackingSlip(ctx: PoPsDocContext): Promise<ReactNode> {
  const layout = await resolveThemeLayout(LAYOUT_TYPE, { moduleName: MODULE_NAME })
  const source = (layout?.builderData as Data | undefined) ?? (PO_PACKING_SLIP_FALLBACK_DATA as unknown as Data)

  // Loaded here rather than imported at the top: config.rsc reaches next/headers
  // through other modules' RSC blocks, and a static import would drag that into
  // every caller.
  const { getModuleLayoutPuckRscConfig } = await import('@/lib/puck/config.rsc')
  const data = injectPoPsDocContext(source, ctx)
  return <Render config={getModuleLayoutPuckRscConfig(LAYOUT_TYPE)} data={data as Data} />
}

/** The paper, margins and scale the layout asks to be printed on. */
export async function poPackingSlipPageSetup(): Promise<DocPageSetup> {
  const layout = await resolveThemeLayout(LAYOUT_TYPE, { moduleName: MODULE_NAME })
  return docPageSetupFromLayout(layout?.builderData ?? null)
}

// ---------------------------------------------------------------------------
// The running footer
// ---------------------------------------------------------------------------
//
// Core's, shared with the order, the returns note, the invoice and the quote -
// see the long note in lib/document.tsx. The same compatibility shape is needed
// here and for the same reason: a shared footer may hold the shop's own footer
// blocks, which read `_ctx.invoice.*` and would throw when handed anything else,
// taking the whole PDF page with them. Nothing is imported from the shop; this
// is a JSON shape, not a dependency.
//
// The totals are deliberately blank rather than filled in. There is no money on
// a packing slip, and a footer that printed one would be the one place the rule
// leaked.

type FooterCompatibleContext = PoPsDocContext & { invoice: Record<string, unknown> }

function slipAsDocFooterContext(ctx: PoPsDocContext): FooterCompatibleContext {
  const { slip, buyer, site } = ctx
  return {
    ...ctx,
    invoice: {
      invoiceNumber: slip.number,
      orderNumber: slip.orderNumber,
      taxPointDate: slip.despatchedDate,
      dueDate: null,
      currencySymbol: '',
      subtotal: '',
      taxAmount: '',
      total: '',
      wording: {},
      seller: {
        name: buyer.name,
        addressLines: buyer.addressLines,
        vatNumber: buyer.vatNumber,
        companyNumber: buyer.companyNumber,
        email: buyer.email,
        phone: buyer.phone,
        siteName: site.name,
        siteUrl: site.url,
        logoUrl: site.logoUrl,
      },
      customer: { name: '', company: '', reference: '', email: '', phone: '', billingAddress: [], shippingAddress: [] },
      lines: [],
      taxBreakdown: [],
    },
  }
}

/** The shared PDF footer, rendered for this slip - or null when nobody has
 *  published one, which is every site until somebody makes one. */
export async function renderPoPackingSlipRunningFooter(ctx: PoPsDocContext): Promise<ReactNode | null> {
  return renderDocumentRunningFooter(slipAsDocFooterContext(ctx), {
    fallbackLayoutTypes: ['shopDocumentFooter'],
    moduleName: MODULE_NAME,
  })
}
