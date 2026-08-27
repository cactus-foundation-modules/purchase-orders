import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { cancelOrderLineBalance, getOrder, syncOrderReceiptStatus } from '@/modules/purchase-orders/lib/db'
import { isAmendable } from '@/modules/purchase-orders/lib/lifecycle'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string; lineId: string }> }

/**
 * Cancels the outstanding balance of one line.
 *
 * Its own operation rather than an edit, because the moment it is wanted is
 * exactly the moment an edit is refused: a part-received order, where the
 * supplier has said the last four are never coming. An amendment rewrites every
 * line, and a line with a delivery against it will not be rewritten - quite
 * rightly. This touches one number on one line and nothing else.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id, lineId } = await params
  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  // A draft is simply edited; there is nothing to cancel that deleting the line
  // would not do more honestly.
  if (!isAmendable(order.status)) {
    return errorResponse(
      order.status === 'DRAFT' || order.status === 'AWAITING_APPROVAL'
        ? 'This order has not gone out yet - edit it and take the line off instead.'
        : `An order that is ${order.status.toLowerCase().replace(/_/g, ' ')} cannot have lines cancelled.`,
      409,
    )
  }

  const line = order.lines.find((l) => l.id === lineId)
  if (!line) return errorResponse('That line is not on this order any more.', 404)

  const result = await cancelOrderLineBalance(id, lineId, user.id)
  if (!result.ok) return errorResponse(result.reason ?? 'That line cannot be cancelled.', 409)

  // Cancelling the balance can complete the order: every remaining line has now
  // had everything it is ever going to get.
  const status = await syncOrderReceiptStatus(id, user.id)

  await recordAudit(
    'order',
    id,
    'line.cancelled',
    { line: line.description, qtyCancelled: result.qtyCancelled, status: status ?? undefined },
    user.id,
  )
  return NextResponse.json({ ok: true, qtyCancelled: result.qtyCancelled, status })
}
