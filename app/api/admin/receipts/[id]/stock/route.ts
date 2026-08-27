import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getReceipt } from '@/modules/purchase-orders/lib/receipts'
import { applyReceiptStock } from '@/modules/purchase-orders/lib/inventory'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

// Adding a delivery to stock after the fact.
//
// Booking goods in and moving stock are deliberately two things. A site can have
// the toggle off, switch it on next month, and still want last week's delivery
// on the shelf; a site whose shop was installed after its purchasing was is in
// exactly the same position. `stock_applied` is what makes pressing this twice
// harmless.
export async function POST(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canReceive) return errorResponse('Forbidden', 403)

  const { id } = await params
  const receipt = await getReceipt(id)
  if (!receipt) return errorResponse('That delivery is not here any more.', 404)

  const outcome = await applyReceiptStock(receipt, user.id)
  if (!outcome.applied) return errorResponse(outcome.reason, 409)

  await recordAudit(
    'order',
    receipt.orderId,
    'receipt.stocked',
    { receipt: receipt.number, result: outcome.result },
    user.id,
  )
  return NextResponse.json({ ok: true, result: outcome.result })
}
