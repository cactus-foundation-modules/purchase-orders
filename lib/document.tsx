import type { ReactNode } from 'react'
import { Render } from '@puckeditor/core/rsc'
import type { Data } from '@puckeditor/core'
import { prisma } from '@/lib/db/prisma'
import { getSiteUrl } from '@/lib/config/env'
import { resolveThemeLayout } from '@/lib/layout/resolveThemeLayout'
import { renderDocumentRunningFooter } from '@/lib/documents/footer'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import {
  getOrder, getOrderPeople, getOrderSupplierSnapshot, getOrderWording, getSupplier,
  shopTradingIdentity, userNames,
} from '@/modules/purchase-orders/lib/db'
import { injectPoDocContext, type PoDocContext, type PoDocParty } from '@/modules/purchase-orders/lib/doc-context'
import { docPageSetupFromLayout, type DocPageSetup } from '@/modules/purchase-orders/lib/doc-page-settings'
import { PO_DOCUMENT_FALLBACK_DATA } from '@/modules/purchase-orders/lib/starterLayouts'
import { PO_STATUS_LABELS, type PoOrder, type PoStatus, type PoSupplier } from '@/modules/purchase-orders/lib/types'
import type { PoAddress } from '@/modules/purchase-orders/lib/config'

// Rendering the purchase order document. One layout, two surfaces:
//
//  - /purchase-order/<number>   the page an admin opens, signed token and all
//  - the PDF                    a headless browser printing that same page
//
// Both go through here, so the thing on screen and the thing in the PDF are the
// same document by construction rather than by two renderings agreeing with each
// other for now.
//
// SERVER ONLY. The context TYPES and the sample live in lib/doc-context.ts,
// which is client-safe because the blocks import it; gathering the real thing
// happens here.

const LAYOUT_TYPE = 'purchaseOrderDocument'
const MODULE_NAME = 'purchase-orders'

/** An address record as a run of lines, with the blanks dropped. */
function addressLines(address: PoAddress | null | undefined): string[] {
  if (!address) return []
  return [address.line1, address.line2, address.city, address.region, address.postcode, address.country]
    .map((line) => (line ?? '').trim())
    .filter(Boolean)
}

/** A textarea of address lines as an array, blank lines dropped - the shape the
 *  settings screen stores and the shop's own invoice address uses. */
function textLines(value: string | null | undefined): string[] {
  return (value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

const EMPTY_PARTY: PoDocParty = {
  name: '', addressLines: [], contactName: '', email: '', phone: '',
  vatNumber: '', companyNumber: '', accountNumber: '',
}

/** The supplier, off the order's own frozen copy where it has one. Anything the
 *  snapshot is missing - it was written by an older release, say - falls back to
 *  the live row rather than printing a blank. */
function partyFromSnapshot(raw: Record<string, unknown>, live: PoDocParty): PoDocParty {
  const str = (key: keyof PoDocParty): string => {
    const value = raw[key]
    return typeof value === 'string' && value.trim() !== '' ? value : (live[key] as string)
  }
  const lines = Array.isArray(raw.addressLines)
    ? (raw.addressLines as unknown[]).filter((line): line is string => typeof line === 'string')
    : live.addressLines
  return {
    name: str('name'),
    addressLines: lines,
    contactName: str('contactName'),
    email: str('email'),
    phone: str('phone'),
    vatNumber: str('vatNumber'),
    companyNumber: str('companyNumber'),
    accountNumber: str('accountNumber'),
  }
}

/** The supplier as the document draws them, from this module's own row. */
export function supplierParty(supplier: PoSupplier | null): PoDocParty {
  if (!supplier) return EMPTY_PARTY
  return {
    name: supplier.name,
    addressLines: addressLines(supplier.address),
    contactName: supplier.contactName ?? '',
    email: supplier.email ?? '',
    phone: supplier.phone ?? '',
    vatNumber: supplier.taxRegistrationNumber ?? '',
    companyNumber: '',
    accountNumber: supplier.accountNumber ?? '',
  }
}

/**
 * Us, as the document draws us.
 *
 * This module's own settings first. Anything left blank falls back to the shop's
 * invoice identity where a shop is installed - read out of its settings row by
 * raw SQL, never by importing it - so a business that has already told the shop
 * its VAT number does not have to tell this module as well.
 */
export async function buyerParty(): Promise<PoDocParty> {
  const [config, shop, site] = await Promise.all([
    getPoConfigCached(),
    shopTradingIdentity(),
    prisma.siteConfig.findUnique({ where: { id: 'singleton' }, select: { siteName: true } }).catch(() => null),
  ])
  const org = config.organisation
  const pick = (mine: string, theirs: string | undefined, last = '') => mine.trim() || (theirs ?? '').trim() || last
  const address = org.address.trim() ? org.address : (shop?.invoiceAddress ?? '')
  return {
    name: pick(org.name, shop?.invoiceBusinessName, (shop?.shopTitle ?? '').trim() || site?.siteName || ''),
    addressLines: textLines(address),
    contactName: org.contactName.trim(),
    email: pick(org.email, shop?.invoiceContactEmail, (shop?.storeEmail ?? '').trim()),
    phone: pick(org.phone, shop?.invoiceContactPhone),
    vatNumber: pick(org.vatNumber, shop?.invoiceVatNumber),
    companyNumber: pick(org.companyNumber, shop?.invoiceCompanyNumber),
    accountNumber: '',
  }
}

/** Everything the document's blocks need, gathered once. Null when the order is
 *  not there any more, which the callers turn into a 404. */
export async function loadPoDocContext(
  orderId: string,
  opts?: { print?: boolean },
): Promise<PoDocContext | null> {
  const order = await getOrder(orderId)
  if (!order) return null

  const [config, buyer, supplier, snapshot, wording, people, site] = await Promise.all([
    getPoConfigCached(),
    buyerParty(),
    getSupplier(order.supplierId),
    getOrderSupplierSnapshot(orderId),
    getOrderWording(orderId),
    getOrderPeople(orderId),
    prisma.siteConfig
      .findUnique({ where: { id: 'singleton' }, select: { siteName: true, logoMediaId: true } })
      .catch(() => null),
  ])

  const logo = site?.logoMediaId
    ? await prisma.media.findUnique({ where: { id: site.logoMediaId }, select: { url: true } }).catch(() => null)
    : null

  const names = await userNames([people.createdByUserId, people.approvedByUserId])
  const live = supplierParty(supplier)

  return {
    order: {
      number: order.number,
      revision: order.revision,
      status: order.status,
      statusLabel: PO_STATUS_LABELS[order.status as PoStatus] ?? order.status,
      currency: order.currency,
      taxMode: order.taxMode,
      raisedDate: order.raisedDate,
      requiredByDate: order.requiredByDate,
      expectedDate: order.expectedDate,
      paymentTerms: order.paymentTerms ?? '',
      deliveryTerms: order.deliveryTerms ?? '',
      // Deliberately notes_supplier ONLY. notes_internal never enters the
      // document context at all, so no block can print it and no future block can
      // start: "check they have not stitched us up on carriage again" must not be
      // one careless drag away from the page that gets emailed to them.
      notesSupplier: order.notesSupplier ?? '',
      subtotal: order.subtotal,
      discountAmount: order.discountAmount,
      carriageAmount: order.carriageAmount,
      taxAmount: order.taxAmount,
      total: order.total,
      lines: order.lines.map((line) => ({
        id: line.id,
        description: line.description,
        productName: line.productName,
        supplierSku: line.supplierSku,
        ourSku: line.ourSku,
        qty: line.qty,
        unit: line.unit,
        unitCost: line.unitCost,
        discountPercent: line.discountPercent,
        taxRatePercent: line.taxRatePercent,
        lineTotal: line.lineTotal,
        expectedDate: line.expectedDate,
        qtyCancelled: line.qtyCancelled,
        serviceName: line.serviceName,
      })),
      shipTo: {
        name: order.shipTo.name,
        contact: order.shipTo.contact,
        phone: order.shipTo.phone,
        addressLines: addressLines(order.shipTo.address),
        instructions: order.shipTo.instructions,
      },
      raisedByName: people.createdByUserId ? (names[people.createdByUserId] ?? '') : '',
      approvedByName: people.approvedByUserId ? (names[people.approvedByUserId] ?? '') : '',
      approvedAt: order.approvedAt,
    },
    buyer,
    // The frozen copy wins once there is one. A supplier renamed or deleted after
    // the order went out must not rewrite paperwork they are already holding.
    supplier: snapshot ? partyFromSnapshot(snapshot, live) : live,
    site: {
      name: site?.siteName ?? '',
      logoUrl: logo?.url ?? null,
      url: getSiteUrl(),
    },
    // The wording frozen at first send, else what settings says today. Same
    // reasoning: re-wording the terms next March must not silently re-word an
    // order somebody accepted last year.
    copy: {
      heading: wording.heading ?? config.wording.heading,
      intro: wording.intro ?? config.wording.intro,
      terms: wording.terms ?? config.wording.terms,
      footerNote: wording.footerNote ?? config.wording.footerNote,
    },
    print: opts?.print ?? false,
  }
}

/** The wording to freeze onto an order at first send. */
export async function wordingSnapshot(): Promise<Record<string, string>> {
  const config = await getPoConfigCached()
  return {
    heading: config.wording.heading,
    intro: config.wording.intro,
    terms: config.wording.terms,
    footerNote: config.wording.footerNote,
  }
}

/**
 * The document as a React tree: the published `purchaseOrderDocument` layout with
 * the context injected into its part-blocks, or the standard starter's own blocks
 * when nothing has been published.
 *
 * Unlike a quote, this one NEVER refuses. A quote with no layout can say "ask an
 * administrator to publish one"; a purchase order cannot, because somebody is
 * standing at a goods-in desk holding the other copy of it - and because the
 * layout type is new to any site that already had this module installed, module
 * layout starters being seeded at install.
 */
export async function renderPoDocument(ctx: PoDocContext): Promise<ReactNode> {
  const layout = await resolveThemeLayout(LAYOUT_TYPE, { moduleName: MODULE_NAME })
  const source = (layout?.builderData as Data | undefined) ?? (PO_DOCUMENT_FALLBACK_DATA as unknown as Data)

  // Loaded here rather than imported at the top: config.rsc reaches next/headers
  // through other modules' RSC blocks, and a static import would drag that into
  // every caller.
  const { getModuleLayoutPuckRscConfig } = await import('@/lib/puck/config.rsc')
  const data = injectPoDocContext(source, ctx)
  return <Render config={getModuleLayoutPuckRscConfig(LAYOUT_TYPE)} data={data as Data} />
}

/** The paper, margins and scale the layout asks to be printed on. */
export async function poDocumentPageSetup(): Promise<DocPageSetup> {
  const layout = await resolveThemeLayout(LAYOUT_TYPE, { moduleName: MODULE_NAME })
  return docPageSetupFromLayout(layout?.builderData ?? null)
}

// ---------------------------------------------------------------------------
// The running footer
// ---------------------------------------------------------------------------
//
// NOT this module's own. A business's paperwork - the purchase order, the
// supplier's invoice, the customer invoice and the quote it started as - is one
// folder on somebody's desk, and a footer designed once belongs on all of it. So
// there is exactly one footer layout type, `documentFooter`, and it is CORE's.
//
// `shopDocumentFooter` is named below as a fallback and nothing more: it is the
// layout type the shop shipped before core had one, so a site that designed a
// footer under the old key keeps printing it here with nothing migrated. A string
// in a list, not an import.
//
// The stand-in below is the awkward part and it is deliberate. A shared footer
// may hold the SHOP's footer blocks, and those read `_ctx.invoice.*`. Shop was
// taught in the Stage 10 pass to tolerate a document that has no invoice on it,
// so the worst case is now a blank token rather than a thrown block taking the
// whole PDF page with it - but blank is not what anybody wants in the footer of
// a purchase order. So the context passed to the footer carries this order in
// the shape those blocks read, as plain data, and the footer prints the real
// number and the real total. Nothing is imported from the shop module and
// nothing is typed against it: this is a JSON shape, not a dependency. Only the
// fields a FOOTER can print are filled - the trading identity, the document's
// own number and its totals; lines, customers and tax breakdowns are left empty
// rather than invented, because no footer block reads them.

type FooterCompatibleContext = PoDocContext & { invoice: Record<string, unknown> }

function poAsDocFooterContext(ctx: PoDocContext): FooterCompatibleContext {
  const { order, buyer, site } = ctx
  return {
    ...ctx,
    invoice: {
      invoiceNumber: order.number,
      orderNumber: order.number,
      taxPointDate: order.raisedDate ?? '',
      dueDate: null,
      currencySymbol: '',
      subtotal: order.subtotal,
      taxAmount: order.taxAmount,
      total: order.total,
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

/** The shared PDF footer, rendered for this order - or null when nobody has
 *  published one, which is every site until somebody makes one. */
export async function renderPoRunningFooter(ctx: PoDocContext): Promise<ReactNode | null> {
  return renderDocumentRunningFooter(poAsDocFooterContext(ctx), {
    fallbackLayoutTypes: ['shopDocumentFooter'],
    moduleName: MODULE_NAME,
  })
}

/** The order as it stands, as a revision snapshot: the whole document, lines and
 *  all, so what the supplier was sent can be read back exactly. */
export function orderRevisionSnapshot(order: PoOrder): Record<string, unknown> {
  return { ...order } as unknown as Record<string, unknown>
}
