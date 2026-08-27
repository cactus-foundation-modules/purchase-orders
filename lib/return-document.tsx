import type { ReactNode } from 'react'
import { Render } from '@puckeditor/core/rsc'
import type { Data } from '@puckeditor/core'
import { prisma } from '@/lib/db/prisma'
import { getSiteUrl } from '@/lib/config/env'
import { resolveThemeLayout } from '@/lib/layout/resolveThemeLayout'
import { renderDocumentRunningFooter } from '@/lib/documents/footer'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { getOrderSupplierSnapshot, getSupplier, userNames } from '@/modules/purchase-orders/lib/db'
import { getReturn } from '@/modules/purchase-orders/lib/returns'
import { buyerParty, supplierParty } from '@/modules/purchase-orders/lib/document'
import { injectPoRetDocContext, type PoRetDocContext } from '@/modules/purchase-orders/lib/return-doc-context'
import { docPageSetupFromLayout, type DocPageSetup } from '@/modules/purchase-orders/lib/doc-page-settings'
import { PO_RETURN_FALLBACK_DATA } from '@/modules/purchase-orders/lib/starterLayouts'
import { PO_RETURN_STATUS_LABELS, type PoReturnStatus } from '@/modules/purchase-orders/lib/types'
import type { PoDocParty } from '@/modules/purchase-orders/lib/doc-context'

// Rendering the returns note. Same two surfaces as the purchase order:
//
//  - /purchase-order/returns/<number>   the page an admin opens, signed token and all
//  - the PDF                            a headless browser printing that same page
//
// SERVER ONLY. The context TYPES and the sample live in lib/return-doc-context.ts,
// which is client-safe because the blocks import it.

const LAYOUT_TYPE = 'purchaseReturnDocument'
const MODULE_NAME = 'purchase-orders'

/** The supplier, off the ORDER's frozen copy where it has one. A return is a
 *  claim against the same supplier the order went to, and a rename between the
 *  order going out and the goods coming back must not quietly re-address it. */
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

/** Everything the note's blocks need, gathered once. Null when the return is not
 *  there any more, which the callers turn into a 404. */
export async function loadPoRetDocContext(
  returnId: string,
  opts?: { print?: boolean },
): Promise<PoRetDocContext | null> {
  const ret = await getReturn(returnId)
  if (!ret) return null

  const [config, buyer, supplier, snapshot, order, site] = await Promise.all([
    getPoConfigCached(),
    buyerParty(),
    getSupplier(ret.supplierId),
    getOrderSupplierSnapshot(ret.orderId),
    orderDates(ret.orderId),
    prisma.siteConfig
      .findUnique({ where: { id: 'singleton' }, select: { siteName: true, logoMediaId: true } })
      .catch(() => null),
  ])

  const logo = site?.logoMediaId
    ? await prisma.media.findUnique({ where: { id: site.logoMediaId }, select: { url: true } }).catch(() => null)
    : null

  const names = await userNames([ret.createdByUserId])
  const live = supplierParty(supplier)

  // Which delivery each line came in on, for the supplier's own goods-in desk.
  const receiptNumbers = await receiptNumbersFor(ret.lines.map((l) => l.receiptLineId))

  return {
    ret: {
      number: ret.number,
      status: ret.status,
      statusLabel: PO_RETURN_STATUS_LABELS[ret.status as PoReturnStatus] ?? ret.status,
      raisedDate: ret.raisedDate,
      orderNumber: ret.orderNumber,
      orderDate: order?.raisedDate ?? null,
      reason: ret.reason ?? '',
      notes: ret.notes ?? '',
      currency: ret.currency,
      subtotal: subtotalOf(ret.lines),
      taxAmount: ret.taxAmount,
      creditExpected: ret.creditExpected,
      creditRef: ret.creditRef ?? '',
      lines: ret.lines.map((line) => ({
        id: line.id,
        description: line.description,
        supplierSku: line.supplierSku,
        qty: line.qty,
        unit: line.unit,
        unitCost: line.unitCost,
        taxRatePercent: line.taxRatePercent,
        lineTotal: line.lineTotal,
        receiptNumber: line.receiptLineId ? (receiptNumbers[line.receiptLineId] ?? null) : null,
      })),
      raisedByName: ret.createdByUserId ? (names[ret.createdByUserId] ?? '') : '',
    },
    buyer,
    supplier: snapshot ? partyFromSnapshot(snapshot, live) : live,
    site: {
      name: site?.siteName ?? '',
      logoUrl: logo?.url ?? null,
      url: getSiteUrl(),
    },
    copy: {
      heading: config.returnWording.heading,
      intro: config.returnWording.intro,
      terms: config.returnWording.terms,
      // The footer note is the ORDER's: it is a business's own registration
      // strip, printed at the foot of everything it sends, and asking somebody to
      // type it twice would be asking for the two to disagree.
      footerNote: config.wording.footerNote,
    },
    print: opts?.print ?? false,
  }
}

/** The net of everything going back, added up from the lines rather than stored:
 *  credit_expected on the header already carries the tax. */
function subtotalOf(lines: { lineTotal: string }[]): string {
  const pence = lines.reduce((sum, line) => sum + Math.round(Number(line.lineTotal) * 100), 0)
  return (pence / 100).toFixed(2)
}

async function orderDates(orderId: string): Promise<{ raisedDate: string | null } | null> {
  const rows = await prisma.$queryRaw<{ raised_date: Date | null }[]>`
    SELECT "raised_date" FROM "po_orders" WHERE "id" = ${orderId} LIMIT 1
  `
  const raw = rows[0]?.raised_date
  if (!raw) return { raisedDate: null }
  const date = raw instanceof Date ? raw : new Date(String(raw))
  return { raisedDate: Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10) }
}

/** Delivery numbers for a handful of receipt lines, in one round trip. */
async function receiptNumbersFor(ids: (string | null)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (wanted.length === 0) return {}
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT rl."id", r."number"
      FROM "po_receipt_lines" rl
      JOIN "po_receipts" r ON r."id" = rl."receipt_id"
     WHERE rl."id" = ANY(${wanted}::text[])
  `
  const out: Record<string, string> = {}
  for (const row of rows) out[row.id as string] = (row.number as string | null) ?? ''
  return out
}

/**
 * The note as a React tree: the published `purchaseReturnDocument` layout with
 * the context injected into its part-blocks, or the standard starter's own
 * blocks when nothing has been published.
 *
 * Never refuses, for the same reason the order never does: somebody is standing
 * beside a pallet with a courier waiting, and "ask an administrator to publish a
 * layout" is not an answer they can act on.
 */
export async function renderPoReturnDocument(ctx: PoRetDocContext): Promise<ReactNode> {
  const layout = await resolveThemeLayout(LAYOUT_TYPE, { moduleName: MODULE_NAME })
  const source = (layout?.builderData as Data | undefined) ?? (PO_RETURN_FALLBACK_DATA as unknown as Data)

  // Loaded here rather than imported at the top: config.rsc reaches next/headers
  // through other modules' RSC blocks, and a static import would drag that into
  // every caller.
  const { getModuleLayoutPuckRscConfig } = await import('@/lib/puck/config.rsc')
  const data = injectPoRetDocContext(source, ctx)
  return <Render config={getModuleLayoutPuckRscConfig(LAYOUT_TYPE)} data={data as Data} />
}

/** The paper, margins and scale the layout asks to be printed on. */
export async function poReturnPageSetup(): Promise<DocPageSetup> {
  const layout = await resolveThemeLayout(LAYOUT_TYPE, { moduleName: MODULE_NAME })
  return docPageSetupFromLayout(layout?.builderData ?? null)
}

// ---------------------------------------------------------------------------
// The running footer
// ---------------------------------------------------------------------------
//
// Core's, shared with the order, the invoice and the quote - see the long note
// in lib/document.tsx. The same compatibility shape is needed here and for the
// same reason: a shared footer may hold the shop's own footer blocks, which read
// `_ctx.invoice.*` and would throw when handed anything else, taking the whole
// PDF page with them. Nothing is imported from the shop; this is a JSON shape,
// not a dependency.

type FooterCompatibleContext = PoRetDocContext & { invoice: Record<string, unknown> }

function retAsDocFooterContext(ctx: PoRetDocContext): FooterCompatibleContext {
  const { ret, buyer, site } = ctx
  return {
    ...ctx,
    invoice: {
      invoiceNumber: ret.number,
      orderNumber: ret.orderNumber,
      taxPointDate: ret.raisedDate ?? '',
      dueDate: null,
      currencySymbol: '',
      subtotal: ret.subtotal,
      taxAmount: ret.taxAmount,
      total: ret.creditExpected,
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

/** The shared PDF footer, rendered for this return - or null when nobody has
 *  published one, which is every site until somebody makes one. */
export async function renderPoReturnRunningFooter(ctx: PoRetDocContext): Promise<ReactNode | null> {
  return renderDocumentRunningFooter(retAsDocFooterContext(ctx), {
    fallbackLayoutTypes: ['shopDocumentFooter'],
    moduleName: MODULE_NAME,
  })
}
