import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getReturn, setReturnStatus } from '@/modules/purchase-orders/lib/returns'
import {
  checkReturnTransition, creditOutstanding, type PoReturnTransition,
} from '@/modules/purchase-orders/lib/returning'
import { ReturnTransitionBody } from '@/modules/purchase-orders/lib/return-body'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

// POST - move a return along, and record the credit when it lands.
//
// The one route that writes po_returns.status. The guard is lib/returning.ts and
// the audit line is written here, exactly as the order's transition route does
// it: six screens pushing at a state machine from six directions is how one ends
// up with statuses nobody can explain.
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = ReturnTransitionBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const ret = await getReturn(id)
  if (!ret) return errorResponse('That return is not here any more.', 404)

  const transition = parsed.data.transition as PoReturnTransition
  const check = checkReturnTransition(transition, ret.status, access)
  if (!check.ok) return errorResponse(check.reason, 409)

  // Recording a credit with no amount means the whole of what was claimed. A
  // supplier who credits it in full is the ordinary case, and making somebody
  // retype a figure that is already on the screen is how figures get typed wrong.
  const creditReceived =
    transition === 'credited' ? (parsed.data.creditReceived ?? ret.creditExpected) : null

  await setReturnStatus(id, check.to, {
    creditReceived,
    ...(transition === 'credited' ? { creditRef: parsed.data.creditRef } : {}),
  })

  await recordAudit(
    'return',
    id,
    `return.${transition}`,
    {
      to: check.to,
      note: parsed.data.note ?? undefined,
      creditReceived: creditReceived ?? undefined,
      creditRef: transition === 'credited' ? (parsed.data.creditRef ?? undefined) : undefined,
    },
    user.id,
  )

  return NextResponse.json({
    ok: true,
    status: check.to,
    outstanding: creditOutstanding(ret.creditExpected, creditReceived ?? ret.creditReceived),
  })
}
