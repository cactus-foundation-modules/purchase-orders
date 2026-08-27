import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getReturn } from '@/modules/purchase-orders/lib/returns'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { poReturnDocumentPdf } from '@/modules/purchase-orders/lib/return-pdf'
import { PoPdfUnavailableError, poPdfFilename } from '@/modules/purchase-orders/lib/pdf'

type Params = { params: Promise<{ id: string }> }

// GET - the returns note as a PDF, for whoever is looking at it in the admin.
export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const [ret, config] = await Promise.all([getReturn(id), getPoConfigCached()])
  if (!ret) return errorResponse('That return is not here any more.', 404)

  try {
    const pdf = await poReturnDocumentPdf(ret.number)
    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${poPdfFilename(config.returnPdfFilenamePrefix, ret.number)}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    if (error instanceof PoPdfUnavailableError) {
      console.error('[purchase-orders] return PDF unavailable:', error.message)
      return errorResponse('This return could not be turned into a PDF. The on-screen copy is still there.', 503)
    }
    console.error('[purchase-orders] return PDF failed', error)
    return errorResponse('Something went wrong making that PDF.', 500)
  }
}
