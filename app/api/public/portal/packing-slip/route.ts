import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { getShipmentIdByNumber, shipmentOrderId } from '@/modules/purchase-orders/lib/shipments'
import { poPackingSlipFilename, poPackingSlipPdf } from '@/modules/purchase-orders/lib/packing-slip-pdf'
import { PoPdfUnavailableError } from '@/modules/purchase-orders/lib/pdf'
import { resolvePortalToken } from '@/modules/purchase-orders/lib/portal'
import { PORTAL_TOKEN_QUERY_KEY } from '@/modules/purchase-orders/lib/portal-token'
import {
  allowPortalReadIp, allowPortalReadToken, portalClientIp,
} from '@/modules/purchase-orders/lib/portal-rate-limit'

// GET - the packing slip for one despatch, as a PDF, for the supplier who filed
// it.
//
// This is the sheet that goes in the box, so it is the one download on the
// portal that has a job to do rather than being a convenience. It stays
// available afterwards: a supplier who loses the file, or ships a second pallet
// against the same drop, comes back to the same link and gets the same slip.
//
// Scoped twice over. The key opens one ORDER, and the despatch asked for has to
// belong to that order - so a supplier holding one link cannot walk the despatch
// numbers and read somebody else's customer's address.
export async function GET(request: NextRequest) {
  const ip = portalClientIp(request)
  if (!allowPortalReadIp(ip)) {
    return errorResponse('That is a lot of downloads at once. Give it a few minutes.', 429)
  }

  const params = request.nextUrl.searchParams
  const key = params.get(PORTAL_TOKEN_QUERY_KEY)
  const number = (params.get('d') ?? '').trim()

  const config = await getPoConfigCached()
  if (!config.portalEnabled) return errorResponse('That link is not open any more.', 404)

  const token = await resolvePortalToken(key)
  if (!token) return errorResponse('That link is not open any more.', 404)
  if (!allowPortalReadToken(token.hash)) {
    return errorResponse('That is a lot of downloads at once. Give it a few minutes.', 429)
  }

  const id = number ? await getShipmentIdByNumber(number) : null
  const orderId = id ? await shipmentOrderId(id) : null
  // One 404 for a despatch that never existed and one belonging to somebody
  // else's order alike.
  if (!id || !orderId || orderId !== token.orderId) {
    return errorResponse('That delivery is not on this order.', 404)
  }

  try {
    const pdf = await poPackingSlipPdf(number)
    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${poPackingSlipFilename(config.packingSlipFilenamePrefix, number)}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    if (error instanceof PoPdfUnavailableError) {
      console.error('[purchase-orders] packing slip unavailable:', error.message)
      return errorResponse('We could not make that packing slip just now. Try again in a moment.', 503)
    }
    console.error('[purchase-orders] packing slip failed', error)
    return errorResponse('Something went wrong making that packing slip.', 500)
  }
}
