import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder, setOrderStatus } from '@/modules/purchase-orders/lib/db'
import { checkTransition, TRANSITIONS } from '@/modules/purchase-orders/lib/lifecycle'
import type { PoTransition } from '@/modules/purchase-orders/lib/lifecycle'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

const Body = z.object({
  transition: z.enum(Object.keys(TRANSITIONS) as [PoTransition, ...PoTransition[]]),
  note: z.string().max(2000).optional(),
})

// Every status change on an order comes through this one route: the guard is in
// lib/lifecycle.ts, the write is in lib/db.ts, and the audit line is written
// here. Nothing else in the module is allowed to set po_orders.status.
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  const { transition, note } = parsed.data
  const check = checkTransition(transition, order.status, access)
  if (!check.ok) return errorResponse(check.reason, 409)

  // Approval is the one transition that can be refused on grounds other than
  // state: an order that never needed approving has nothing to approve.
  if (transition === 'submit' && !order.approvalRequired) {
    return errorResponse('This order does not need approving. Send it straight to the supplier.', 409)
  }

  await setOrderStatus(
    id,
    check.to,
    {
      approvalNote: transition === 'approve' || transition === 'reject' ? (note ?? null) : undefined,
      acknowledgedNote: note ?? null,
      cancelReason: note ?? null,
      closeReason: note ?? null,
    },
    user.id,
  )

  await recordAudit('order', id, `order.${transition}`, { from: order.status, to: check.to, note: note ?? null }, user.id)
  return NextResponse.json({ ok: true, status: check.to, label: check.label })
}
