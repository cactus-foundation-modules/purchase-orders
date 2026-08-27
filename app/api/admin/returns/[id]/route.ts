import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { listAudit, recordAudit } from '@/modules/purchase-orders/lib/audit'
import {
  deleteReturn, getReturn, listReturnableLines, updateReturn,
} from '@/modules/purchase-orders/lib/returns'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import {
  availableReturnTransitions, isReturnEditable, returnTotals, validateReturnDrafts,
} from '@/modules/purchase-orders/lib/returning'
import { ReturnBody, returnDrafts, orNull } from '@/modules/purchase-orders/lib/return-body'
import { reverseReturnStock, stockBlockedReason } from '@/modules/purchase-orders/lib/inventory'
import { hasBookSinks } from '@/modules/purchase-orders/lib/book-sinks'

type Params = { params: Promise<{ id: string }> }

// GET - one return, everything the screen draws: the note, what could still go
// back on the order behind it, its history, and which buttons this user gets.
export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const ret = await getReturn(id)
  if (!ret) return errorResponse('That return is not here any more.', 404)

  const [returnable, history, stockBlocked, hasBooks] = await Promise.all([
    listReturnableLines(ret.orderId),
    listAudit('return', id),
    stockBlockedReason(),
    hasBookSinks(),
  ])

  return NextResponse.json({
    return: ret,
    returnable,
    history,
    stockBlocked,
    hasBooks,
    transitions: availableReturnTransitions(ret.status, access),
  })
}

// PUT - save a draft over itself. Anything the supplier is already holding a copy
// of is not edited: it is cancelled and raised again, because a credit claim that
// quietly changes shape after it has gone out is how a supplier stops trusting
// the paperwork.
export async function PUT(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canReceive) return errorResponse('Forbidden', 403)

  const { id } = await params
  const ret = await getReturn(id)
  if (!ret) return errorResponse('That return is not here any more.', 404)
  if (!isReturnEditable(ret.status)) {
    return errorResponse(
      'This return has already gone to the supplier. Cancel it and raise another rather than changing what they are holding.',
      409,
    )
  }

  const parsed = ReturnBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const drafts = returnDrafts(parsed.data)
  if (drafts.length === 0) {
    return errorResponse('Put a quantity against at least one line, or there is nothing to send back.')
  }

  const order = await getOrder(ret.orderId)
  if (!order) return errorResponse('The order behind this return is not here any more.', 404)

  // What is still returnable has to exclude what THIS note already claims, or a
  // draft could never be saved twice without shrinking.
  const returnable = (await listReturnableLines(ret.orderId)).map((line) => {
    const mine = ret.lines
      .filter((l) => l.orderLineId === line.orderLineId)
      .reduce((sum, l) => sum + Number(l.qty), 0)
    return { ...line, qtyReturned: String(Math.max(0, Number(line.qtyReturned) - mine)) }
  })

  const check = validateReturnDrafts(returnable, drafts)
  if (!check.ok) return errorResponse(check.reason, 409)

  const totals = returnTotals(check.lines)
  await updateReturn(id, {
    orderId: ret.orderId,
    supplierId: ret.supplierId,
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
  })

  await recordAudit('return', id, 'return.updated', { lines: check.lines.length, credit: totals.creditExpected }, user.id)
  return NextResponse.json({ ok: true, creditExpected: totals.creditExpected })
}

/**
 * DELETE - unfile a return, and put back anything it took off a stock count.
 *
 * The reversal happens first and is recorded whether or not it worked. The delete
 * goes ahead either way: the return is being unfiled on somebody's say-so, and
 * refusing it because a stock system was busy leaves the paperwork and the shelf
 * disagreeing in both directions at once.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canReceive) return errorResponse('Forbidden', 403)

  const { id } = await params
  const ret = await getReturn(id)
  if (!ret) return errorResponse('That return is not here any more.', 404)

  const reversal = ret.stockApplied ? await reverseReturnStock(ret, user.id) : null

  await deleteReturn(id)
  await recordAudit(
    'order',
    ret.orderId,
    'return.deleted',
    { return: ret.number, stockReversed: Boolean(reversal), stockResult: reversal ?? undefined },
    user.id,
  )

  return NextResponse.json({ ok: true, stockReversed: Boolean(reversal), reversal })
}
