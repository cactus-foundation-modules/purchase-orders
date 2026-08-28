import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { poDocumentPdf } from '@/modules/purchase-orders/lib/order-pdf'
import { PoPdfUnavailableError, poPdfFilename } from '@/modules/purchase-orders/lib/pdf'
import { resolvePortalToken } from '@/modules/purchase-orders/lib/portal'
import { PORTAL_TOKEN_QUERY_KEY } from '@/modules/purchase-orders/lib/portal-token'
import {
  allowPortalReadIp, allowPortalReadToken, portalClientIp,
} from '@/modules/purchase-orders/lib/portal-rate-limit'

// GET - the purchase order as a PDF, for the supplier holding the link.
//
// The same PDF the buyer downloads from the admin, printed by the same code off
// the same page. A supplier who has been emailed a link and wants the order as a
// file to put on their own system should not have to ask for one, and the
// alternative - printing the web page to PDF themselves - loses the layout the
// business designed.
//
// A GET with the key in the query string, because that is what a download link
// in a page has to be, and because it is the same key already sitting in the
// address bar of the page the link is on. Rate limited on the READ buckets: this
// costs a headless browser render, so it is the most expensive thing a supplier
// can ask for, but it writes nothing at all.
export async function GET(request: NextRequest) {
  const ip = portalClientIp(request)
  if (!allowPortalReadIp(ip)) {
    return errorResponse('That is a lot of downloads at once. Give it a few minutes.', 429)
  }

  const key = request.nextUrl.searchParams.get(PORTAL_TOKEN_QUERY_KEY)
  const config = await getPoConfigCached()
  if (!config.portalEnabled) return errorResponse('That link is not open any more.', 404)

  const token = await resolvePortalToken(key)
  if (!token) return errorResponse('That link is not open any more.', 404)
  if (!allowPortalReadToken(token.hash)) {
    return errorResponse('That is a lot of downloads at once. Give it a few minutes.', 429)
  }

  const order = await getOrder(token.orderId)
  if (!order) return errorResponse('That link is not open any more.', 404)

  try {
    const pdf = await poDocumentPdf(order.number)
    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${poPdfFilename(config.pdfFilenamePrefix, order.number)}"`,
        // An order can be amended, so a cached copy would hand the supplier the
        // revision before last - which is the one thing this file must never do.
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    if (error instanceof PoPdfUnavailableError) {
      console.error('[purchase-orders] portal PDF unavailable:', error.message)
      return errorResponse('We could not make that PDF just now. The order is still there on the page.', 503)
    }
    console.error('[purchase-orders] portal PDF failed', error)
    return errorResponse('Something went wrong making that PDF.', 500)
  }
}
