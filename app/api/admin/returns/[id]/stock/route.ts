import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getReturn } from '@/modules/purchase-orders/lib/returns'
import { applyReturnStock } from '@/modules/purchase-orders/lib/inventory'
import { isReturnStockable } from '@/modules/purchase-orders/lib/returning'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

// POST - take a return's goods off the shelf.
//
// Deliberately its own button rather than something the send does on the way
// past: a note can be raised on Monday and the pallet collected on Thursday, and
// deducting on Monday would show a shortage for three days that nobody could
// explain. `stock_applied` is what makes pressing it twice harmless.
export async function POST(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canReceive) return errorResponse('Forbidden', 403)

  const { id } = await params
  const ret = await getReturn(id)
  if (!ret) return errorResponse('That return is not here any more.', 404)
  if (!isReturnStockable(ret.status)) {
    return errorResponse('Nothing has left the building on this return yet, so there is nothing to take off stock.', 409)
  }

  const outcome = await applyReturnStock(ret, user.id)
  if (!outcome.applied) return errorResponse(outcome.reason, 409)

  await recordAudit('return', id, 'return.stocked', { result: outcome.result }, user.id)
  return NextResponse.json({ ok: true, result: outcome.result })
}
