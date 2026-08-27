import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { createOrder, listOrders } from '@/modules/purchase-orders/lib/db'
import { generateOrderNumber } from '@/modules/purchase-orders/lib/numbering'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { needsApproval } from '@/modules/purchase-orders/lib/lifecycle'
import { orderTotals } from '@/modules/purchase-orders/lib/totals'
import { OrderBody, toOrderInput } from '@/modules/purchase-orders/lib/order-body'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import type { PoStatus } from '@/modules/purchase-orders/lib/types'

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const params = request.nextUrl.searchParams
  const result = await listOrders({
    status: (params.get('status') as PoStatus | 'ALL' | 'OPEN' | null) ?? 'OPEN',
    supplierId: params.get('supplierId') ?? undefined,
    search: params.get('search') ?? undefined,
    limit: params.get('limit') ? Number(params.get('limit')) : undefined,
    offset: params.get('offset') ? Number(params.get('offset')) : undefined,
  })
  return NextResponse.json(result)
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const parsed = OrderBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const input = toOrderInput(parsed.data)
  const config = await getPoConfigCached()
  // Totals are worked out on the server, always. The browser sends what it
  // thinks the numbers are only so the person typing can see them change.
  const totals = orderTotals({
    lines: input.lines,
    taxMode: input.taxMode,
    discountAmount: input.discountAmount,
    carriageAmount: input.carriageAmount,
  })

  const number = await generateOrderNumber()
  const id = await createOrder(
    number,
    input,
    totals,
    needsApproval(totals.total, config),
    user.id,
  )
  await recordAudit('order', id, 'order.created', { number, total: totals.total }, user.id)
  return NextResponse.json({ id, number })
}
