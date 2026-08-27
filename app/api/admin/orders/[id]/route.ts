import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { deleteOrder, getOrder, updateOrder } from '@/modules/purchase-orders/lib/db'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { isFreelyEditable, needsApproval } from '@/modules/purchase-orders/lib/lifecycle'
import { orderTotals } from '@/modules/purchase-orders/lib/totals'
import { OrderBody, toOrderInput } from '@/modules/purchase-orders/lib/order-body'
import { listAudit, recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  const history = await listAudit('order', id)
  return NextResponse.json({ order, history })
}

export async function PUT(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const existing = await getOrder(id)
  if (!existing) return errorResponse('That purchase order is not here any more.', 404)

  // Editing an order the supplier already has means bumping the revision and
  // keeping what they were sent - which arrives with the document work. Until
  // then this refuses rather than quietly rewriting history.
  if (!isFreelyEditable(existing.status)) {
    return errorResponse(
      'This order has already gone to the supplier, so it cannot be edited. Put it on hold or cancel it and raise a fresh one.',
      409,
    )
  }

  const parsed = OrderBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const input = toOrderInput(parsed.data)
  const config = await getPoConfigCached()
  const totals = orderTotals({
    lines: input.lines,
    taxMode: input.taxMode,
    discountAmount: input.discountAmount,
    carriageAmount: input.carriageAmount,
  })

  await updateOrder(id, input, totals, needsApproval(totals.total, config), user.id)
  await recordAudit(
    'order',
    id,
    'order.updated',
    { total: totals.total, previousTotal: existing.total, lines: input.lines.length },
    user.id,
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const existing = await getOrder(id)
  if (!existing) return errorResponse('That purchase order is not here any more.', 404)

  // Only a draft can be deleted outright. Anything that has been out into the
  // world gets cancelled instead, so the number and the trail survive.
  if (existing.status !== 'DRAFT') {
    return errorResponse('Only a draft can be deleted. Cancel this one instead.', 409)
  }

  await deleteOrder(id)
  await recordAudit('order', id, 'order.deleted', { number: existing.number }, user.id)
  return NextResponse.json({ ok: true })
}
