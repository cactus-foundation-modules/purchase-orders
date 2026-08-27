import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { poDocumentPdf } from '@/modules/purchase-orders/lib/order-pdf'
import { PoPdfUnavailableError, poPdfFilename } from '@/modules/purchase-orders/lib/pdf'

type Params = { params: Promise<{ id: string }> }

// GET - the purchase order as a PDF, for whoever is looking at it in the admin.
//
// Not rate limited and not public: this is an admin route behind a permission
// check, and the person pressing it is the person paying for the compute.
export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const [order, config] = await Promise.all([getOrder(id), getPoConfigCached()])
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  try {
    const pdf = await poDocumentPdf(order.number)
    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        // `attachment`, so the button saves a file rather than opening a viewer
        // the buyer then has to save from.
        'Content-Disposition': `attachment; filename="${poPdfFilename(config.pdfFilenamePrefix, order.number)}"`,
        // An order can be amended, so a cached copy would hand back the revision
        // before last.
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    // A missing browser, or a site whose own pages it cannot reach, is a
    // configuration fault rather than a bug - so it is reported in words somebody
    // can act on rather than swallowed into a 500 with no explanation.
    if (error instanceof PoPdfUnavailableError) {
      console.error('[purchase-orders] PDF unavailable:', error.message)
      return errorResponse('This order could not be turned into a PDF. The on-screen copy is still there.', 503)
    }
    console.error('[purchase-orders] PDF failed', error)
    return errorResponse('Something went wrong making that PDF.', 500)
  }
}
