import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getSessionFromCookie } from '@/lib/auth/session'
import { DocumentFooterRegion } from '@/lib/documents/page-settings'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrderIdByNumber } from '@/modules/purchase-orders/lib/db'
import { verifyPoPrintToken } from '@/modules/purchase-orders/lib/print-token'
import { loadPoDocContext, renderPoDocument, renderPoRunningFooter } from '@/modules/purchase-orders/lib/document'

// The purchase order document on its own: no site header, no footer, nothing but
// the designed document. Two consumers - somebody in the admin pressing "View
// document", and the headless browser that prints the PDF.
//
// It is a PAGE rather than a route handler returning HTML, and that is not a
// style choice: the tree comes out of Puck's RSC renderer and can hold client
// references, and react-dom/server has no client manifest to resolve those
// against inside a route handler. Rendering it as a page hands the job back to
// Next, which does have one. Quote for Shop learned that the expensive way.
//
// WHO MAY OPEN IT. Two keys and no third:
//
//  1. A short-lived signed token (lib/print-token.ts). This exists because the
//     printing browser fetches this page over HTTP from the site's own public
//     address and carries no session cookie. Something has to open the door for
//     it, for as long as the print takes and no longer.
//  2. A signed-in user holding purchase-orders.access, which is what keeps the
//     page working after the token behind it has aged out.
//
// It is emphatically NOT world-readable by number. Unlike a shop invoice - which
// a customer files and comes back to years later - a purchase order is what this
// business is paying and at what price, the numbers run in sequence, and nobody
// outside the building has any business reading one. The supplier portal, when it
// arrives, mints its own scoped and revocable token rather than borrowing either
// of these.
//
// The site chrome is removed by CSS rather than by opting out of a layout,
// because a module's public pages are always wrapped by core's public layout and
// cannot opt out. That layout's shape is the contract being relied on: it renders
// the page inside `<main>`, with the theme header and footer as siblings. So
// every sibling of `<main>` is hidden and `<main>` is stripped of its own
// spacing. Keyed on core's structure, never on a theme's markup, so no theme can
// break it.

const BARE_CSS = `
  body > *:not(main) { display: none !important; }
  body > main { display: block !important; margin: 0 !important; padding: 0 !important; }
  body { margin: 0; background: var(--color-bg, #fff); }
  .po-view { max-width: 820px; margin: 0 auto; padding: 1.5rem 1.25rem 2.5rem; }
  /* On paper the browser supplies the margins (see renderPoPdf), so the page
     wrapper stops adding its own on top of them. */
  @media print {
    body { background: #fff; }
    .po-view { max-width: none; padding: 0; }
  }
`

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }): Promise<Metadata> {
  const { number } = await params
  return {
    title: `Purchase order ${decodeURIComponent(number)}`,
    // What this business buys, from whom, at what price. Never in a search index.
    robots: { index: false, follow: false },
  }
}

export default async function PurchaseOrderDocumentPage({
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
  const print = query.print === '1'

  let allowed = verifyPoPrintToken(number, token)
  if (!allowed) {
    // The session path, checked second because the printing browser has no
    // session and would otherwise pay for a permission lookup on every page.
    const user = await getSessionFromCookie()
    allowed = Boolean(user && (await getPoAccess(user)).canAccess)
  }
  // A bad token and no session is a 404, not a 403: there is nothing to be gained
  // by confirming that this order number exists.
  if (!allowed) notFound()

  const id = await getOrderIdByNumber(number)
  if (!id) notFound()

  const ctx = await loadPoDocContext(id, { print })
  if (!ctx) notFound()

  const document = await renderPoDocument(ctx)
  // Only when printing: it is a region for the printing browser to lift out, and
  // rendering it on screen would be a layout resolved and a tree built for
  // something nobody can see.
  const runningFooter = print ? await renderPoRunningFooter(ctx) : null

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: BARE_CSS }} />
      <div className="po-view">{document}</div>
      <DocumentFooterRegion>{runningFooter}</DocumentFooterRegion>
    </>
  )
}
