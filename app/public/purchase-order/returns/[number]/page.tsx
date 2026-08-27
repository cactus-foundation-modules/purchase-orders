import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getSessionFromCookie } from '@/lib/auth/session'
import { DocumentFooterRegion } from '@/lib/documents/page-settings'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getReturnIdByNumber } from '@/modules/purchase-orders/lib/returns'
import { verifyPoReturnPrintToken } from '@/modules/purchase-orders/lib/print-token'
import {
  loadPoRetDocContext, renderPoReturnDocument, renderPoReturnRunningFooter,
} from '@/modules/purchase-orders/lib/return-document'

// The returns note on its own: no site header, no footer, nothing but the
// designed document. Two consumers - somebody in the admin pressing "View note",
// and the headless browser that prints the PDF.
//
// It sits UNDER this module's own public base rather than claiming a second one,
// because a module gets exactly one. Two segments deep, so it can never collide
// with the order's own /purchase-order/<number>.
//
// Who may open it is the same two keys and no third: a short-lived signed token
// for the printing browser, or a signed-in user holding purchase-orders.access.
// Anything else is a 404 rather than a 403 - there is nothing to be gained by
// confirming which return numbers exist. The token is signed under its own
// subject, so one minted for an order cannot open a return.
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
    title: `Returns note ${decodeURIComponent(number)}`,
    // What this business is sending back and what it paid for it. Never indexed.
    robots: { index: false, follow: false },
  }
}

export default async function PurchaseReturnDocumentPage({
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

  let allowed = verifyPoReturnPrintToken(number, token)
  if (!allowed) {
    // The session path, checked second because the printing browser has no
    // session and would otherwise pay for a permission lookup on every page.
    const user = await getSessionFromCookie()
    allowed = Boolean(user && (await getPoAccess(user)).canAccess)
  }
  if (!allowed) notFound()

  const id = await getReturnIdByNumber(number)
  if (!id) notFound()

  const ctx = await loadPoRetDocContext(id, { print })
  if (!ctx) notFound()

  const document = await renderPoReturnDocument(ctx)
  const runningFooter = print ? await renderPoReturnRunningFooter(ctx) : null

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: BARE_CSS }} />
      <div className="po-view">{document}</div>
      <DocumentFooterRegion>{runningFooter}</DocumentFooterRegion>
    </>
  )
}
