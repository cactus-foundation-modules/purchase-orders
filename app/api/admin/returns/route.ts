import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import {
  createReturn, listReturnableLines, listReturns, listReturnsForOrder, openCreditTotal,
} from '@/modules/purchase-orders/lib/returns'
import { generateReturnNumber } from '@/modules/purchase-orders/lib/numbering'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { returnTotals, validateReturnDrafts } from '@/modules/purchase-orders/lib/returning'
import { ReturnBody, returnDrafts, orNull } from '@/modules/purchase-orders/lib/return-body'
import { stockBlockedReason } from '@/modules/purchase-orders/lib/inventory'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

// GET - everything the Returns tab draws, in one request: the notes themselves,
// what is still owed across the open ones, and whether stock is in play at all.
export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const params = request.nextUrl.searchParams
  const orderId = params.get('orderId') ?? ''
  const search = params.get('search') ?? ''
  const open = params.get('open') === '1'

  const [returns, credit, stockBlocked] = await Promise.all([
    orderId ? listReturnsForOrder(orderId) : listReturns({ search, open }),
    openCreditTotal(),
    stockBlockedReason(),
  ])

  return NextResponse.json({ returns, credit, stockBlocked })
}

/**
 * POST - raise a return against an order.
 *
 * Over-return is REFUSED rather than flagged, which is the one place this differs
 * from booking a delivery in. A supplier really can send eleven of something you
 * ordered ten of; nobody can send back twelve of something that only ever arrived
 * ten of, and a credit claim that says otherwise is an argument, not a document.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canReceive) return errorResponse('Forbidden', 403)

  const payload = await request.json().catch(() => ({}))
  const orderId = typeof payload?.orderId === 'string' ? payload.orderId : ''
  if (!orderId) return errorResponse('A return has to be against an order.')

  const order = await getOrder(orderId)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  const parsed = ReturnBody.safeParse(payload)
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const drafts = returnDrafts(parsed.data)
  if (drafts.length === 0) {
    return errorResponse('Put a quantity against at least one line, or there is nothing to send back.')
  }

  const returnable = await listReturnableLines(orderId)
  const check = validateReturnDrafts(returnable, drafts)
  if (!check.ok) return errorResponse(check.reason, 409)

  const config = await getPoConfigCached()
  const totals = returnTotals(check.lines)
  const number = await generateReturnNumber()

  const id = await createReturn(
    number,
    {
      orderId,
      supplierId: order.supplierId,
      reason: orNull(parsed.data.reason),
      raisedDate: parsed.data.raisedDate,
      currency: order.currency,
      fxRate: order.fxRate,
      notes: orNull(parsed.data.notes),
      creditExpected: totals.creditExpected,
      lines: check.lines.map((line, index) => ({
        orderLineId: line.orderLineId,
        receiptLineId: line.receiptLineId,
        qty: line.qty,
        unitCost: line.unitCost,
        taxRatePercent: line.taxRatePercent,
        lineTotal: totals.lineTotals[index] ?? '0',
      })),
    },
    user.id,
  )

  await recordAudit(
    'return',
    id,
    'return.created',
    { number, order: order.number, lines: check.lines.length, credit: totals.creditExpected },
    user.id,
  )
  await recordAudit('order', orderId, 'return.raised', { return: number, credit: totals.creditExpected }, user.id)

  return NextResponse.json({ id, number, creditExpected: totals.creditExpected, currency: order.currency, prefix: config.returnNumberPrefix })
}
