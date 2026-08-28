import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getSessionFromCookie } from '@/lib/auth/session'
import { DocumentFooterRegion } from '@/lib/documents/page-settings'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { getShipmentIdByNumber, shipmentOrderId } from '@/modules/purchase-orders/lib/shipments'
import { verifyPoPackingSlipToken } from '@/modules/purchase-orders/lib/print-token'
import { PORTAL_TOKEN_QUERY_KEY } from '@/modules/purchase-orders/lib/portal-token'
import { resolvePortalToken } from '@/modules/purchase-orders/lib/portal'
import {
  allowPortalReadIp, allowPortalReadToken, portalClientIpFrom,
} from '@/modules/purchase-orders/lib/portal-rate-limit'
import {
  loadPoPackingSlipContext, renderPoPackingSlip, renderPoPackingSlipRunningFooter,
} from '@/modules/purchase-orders/lib/packing-slip-document'

// The packing slip on its own: no site header, no footer, nothing but the
// designed document. It sits two segments under this module's own public base,
// so it can never collide with the order's /purchase-order/<number>.
//
// WHO MAY OPEN IT. Three keys, same as the order's page and one of them for a
// different reason:
//
//  1. A short-lived signed token, for the headless browser that prints the PDF.
//     Signed under its own subject, so a token minted for an order cannot open a
//     slip.
//  2. A signed-in user holding purchase-orders.access.
//  3. The SUPPLIER's own portal link, scoped to the order this despatch belongs
//     to. They are the ones printing this and putting it in the box, so this is
//     not an afterthought - it is the main way the sheet ever gets used.
//
// Not world-readable by number. A packing slip names a customer and their
// address, and the numbers run in sequence.
//
// The site chrome is removed by CSS keyed on core's own layout structure - every
// sibling of <main> hidden, <main> stripped of its spacing - never on a theme's
// markup, so no theme can break it.

const BARE_CSS = `
  body > *:not(main) { display: none !important; }
  body > main { display: block !important; margin: 0 !important; padding: 0 !important; }
  body { margin: 0; background: var(--color-bg, #fff); }
  .po-view { max-width: 820px; margin: 0 auto; padding: 1.5rem 1.25rem 2.5rem; }
  @media print {
    body { background: #fff; }
    .po-view { max-width: none; padding: 0; }
  }
`

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }): Promise<Metadata> {
  const { number } = await params
  return {
    title: `Packing slip ${decodeURIComponent(number)}`,
    // A customer's name and address. Never in a search index.
    robots: { index: false, follow: false },
  }
}

export default async function PackingSlipPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { number: raw } = await params
  const number = decodeURIComponent(raw).trim()
  if (!number) notFound()

  const query = (await searchParams) ?? {}
  const token = typeof query.t === 'string' ? query.t : null
  const portalKey = typeof query[PORTAL_TOKEN_QUERY_KEY] === 'string' ? query[PORTAL_TOKEN_QUERY_KEY] : null
  const print = query.print === '1'

  const id = await getShipmentIdByNumber(number)

  let allowed = verifyPoPackingSlipToken(number, token)

  // The supplier's key, checked before the session because the supplier has no
  // session and would otherwise pay for a permission lookup they can never pass.
  if (!allowed && portalKey && id) {
    const requestHeaders = await headers()
    const ip = portalClientIpFrom((name) => requestHeaders.get(name))
    if (allowPortalReadIp(ip)) {
      const config = await getPoConfigCached()
      const resolved = config.portalEnabled ? await resolvePortalToken(portalKey) : null
      // Scoped to one order: the despatch in the address bar has to belong to
      // the order the key was minted for.
      const orderId = resolved ? await shipmentOrderId(id) : null
      if (resolved && orderId && resolved.orderId === orderId && allowPortalReadToken(resolved.hash)) {
        allowed = true
      }
    }
  }

  if (!allowed) {
    const user = await getSessionFromCookie()
    allowed = Boolean(user && (await getPoAccess(user)).canAccess)
  }
  // A bad token and no session is a 404, not a 403: there is nothing to be
  // gained by confirming that this despatch number exists.
  if (!allowed) notFound()
  if (!id) notFound()

  const ctx = await loadPoPackingSlipContext(id, { print })
  if (!ctx) notFound()

  const document = await renderPoPackingSlip(ctx)
  // Only when printing: it is a region for the printing browser to lift out, and
  // rendering it on screen would be a layout resolved and a tree built for
  // something nobody can see.
  const runningFooter = print ? await renderPoPackingSlipRunningFooter(ctx) : null

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: BARE_CSS }} />
      <div className="po-view">{document}</div>
      <DocumentFooterRegion>{runningFooter}</DocumentFooterRegion>
    </>
  )
}
