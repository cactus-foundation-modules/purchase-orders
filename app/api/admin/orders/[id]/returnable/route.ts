import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { listReturnableLines } from '@/modules/purchase-orders/lib/returns'
import { stockBlockedReason } from '@/modules/purchase-orders/lib/inventory'

type Params = { params: Promise<{ id: string }> }

// GET - what could still go back on one order, for the "send something back"
// screen: every line that has actually been delivered, how much of it has gone
// already, and which deliveries each one arrived on.
export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  const [lines, stockBlocked] = await Promise.all([listReturnableLines(id), stockBlockedReason()])
  return NextResponse.json({
    order: {
      id: order.id,
      number: order.number,
      supplierId: order.supplierId,
      supplierName: order.supplierName,
      currency: order.currency,
      status: order.status,
    },
    lines,
    stockBlocked,
  })
}
