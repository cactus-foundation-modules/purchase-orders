import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { deleteShipment, getShipment } from '@/modules/purchase-orders/lib/shipments'

type Params = { params: Promise<{ id: string }> }

/**
 * DELETE - taking a despatch back off the order.
 *
 * A form that can be typed into needs a way to undo a typo, and this is a note
 * about somebody else's lorry rather than a financial record: there is nothing
 * here that has to survive being wrong. What it is NOT is a way to unpick a
 * delivery - goods-in keeps its own rows, and this touches none of them.
 *
 * The packing slip printed off it stops resolving, which is right: a slip for a
 * delivery that was never made is a sheet nobody should be able to fetch. Anyone
 * holding the PDF already keeps the PDF, as they would with any file.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canReceive && !access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const shipment = await getShipment(id)
  if (!shipment) return errorResponse('That despatch is not here any more.', 404)

  await deleteShipment(id)
  await recordAudit(
    'order',
    shipment.orderId,
    'order.despatch-deleted',
    {
      note: `Removed despatch ${shipment.number}, which was sent ${shipment.despatchedDate}`,
      number: shipment.number,
      source: shipment.source,
    },
    user.id,
  )
  return NextResponse.json({ ok: true })
}
