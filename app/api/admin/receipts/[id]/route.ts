import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { deleteReceipt, getReceipt } from '@/modules/purchase-orders/lib/receipts'
import { syncOrderReceiptStatus } from '@/modules/purchase-orders/lib/db'
import { reverseReceiptStock } from '@/modules/purchase-orders/lib/inventory'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const receipt = await getReceipt(id)
  if (!receipt) return errorResponse('That delivery is not here any more.', 404)
  return NextResponse.json({ receipt })
}

/**
 * Deletes a delivery, and puts back anything it added to stock.
 *
 * Deleting the paperwork and leaving the shelf figure where it was is how a
 * stock count quietly stops meaning anything, so the reversal happens first and
 * is recorded whether or not it worked. The delete goes ahead either way: the
 * delivery is being unfiled on somebody's say-so, and refusing it because a
 * stock system was busy leaves the two disagreeing in both directions at once.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canReceive) return errorResponse('Forbidden', 403)

  const { id } = await params
  const receipt = await getReceipt(id)
  if (!receipt) return errorResponse('That delivery is not here any more.', 404)

  const reversal = receipt.stockApplied ? await reverseReceiptStock(receipt, user.id) : null

  await deleteReceipt(id)
  const status = await syncOrderReceiptStatus(receipt.orderId, user.id)

  await recordAudit(
    'order',
    receipt.orderId,
    'receipt.deleted',
    {
      receipt: receipt.number,
      stockReversed: Boolean(reversal),
      stockResult: reversal ?? undefined,
      status: status ?? undefined,
    },
    user.id,
  )

  return NextResponse.json({ ok: true, status, stockReversed: Boolean(reversal), reversal })
}
