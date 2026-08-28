import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { getShipment } from '@/modules/purchase-orders/lib/shipments'
import { poPackingSlipFilename, poPackingSlipPdf } from '@/modules/purchase-orders/lib/packing-slip-pdf'
import { PoPdfUnavailableError } from '@/modules/purchase-orders/lib/pdf'

type Params = { params: Promise<{ id: string }> }

// GET - the packing slip for one despatch, from this side of it.
//
// The supplier prints their own copy off their link; this is for whoever here
// wants the same sheet - to send on, to check against a delivery note, or
// because the supplier has lost theirs.
export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const [shipment, config] = await Promise.all([getShipment(id), getPoConfigCached()])
  if (!shipment) return errorResponse('That delivery is not here any more.', 404)

  try {
    const pdf = await poPackingSlipPdf(shipment.number)
    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${poPackingSlipFilename(config.packingSlipFilenamePrefix, shipment.number)}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    if (error instanceof PoPdfUnavailableError) {
      console.error('[purchase-orders] packing slip unavailable:', error.message)
      return errorResponse('This delivery could not be turned into a packing slip. The on-screen copy is still there.', 503)
    }
    console.error('[purchase-orders] packing slip failed', error)
    return errorResponse('Something went wrong making that packing slip.', 500)
  }
}
