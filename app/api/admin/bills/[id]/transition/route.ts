import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import {
  getBill, openReturnCount, orderInvoicedLines, refreshBillMatch, setBillApprover, setBillStatus,
} from '@/modules/purchase-orders/lib/bills'
import {
  checkBillTransition, shouldAutoClose, type PoBillTransition,
} from '@/modules/purchase-orders/lib/billing'
import { BillTransitionBody, orNull } from '@/modules/purchase-orders/lib/bill-body'
import { getOrder, setOrderStatus } from '@/modules/purchase-orders/lib/db'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

/**
 * POST - move a bill along.
 *
 * The one route that writes po_bills.status. The guard is lib/billing.ts and the
 * audit line is written here, exactly as the order's and the return's transition
 * routes do it.
 *
 * Approving does NOT refuse a bill the match dislikes. Approving in spite of a
 * variance is a decision a person is entitled to make - the supplier really did
 * send two extra and we really are keeping them - and the flags stay recorded on
 * the bill so the decision is on the record rather than quietly erased.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = BillTransitionBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const bill = await getBill(id)
  if (!bill) return errorResponse('That bill is not here any more.', 404)

  const transition = parsed.data.transition as PoBillTransition
  const check = checkBillTransition(transition, bill.status, access)
  if (!check.ok) return errorResponse(check.reason, 409)

  const note = orNull(parsed.data.note)

  // The match is settled at the moment of approval rather than left at whatever
  // it said when the invoice was typed, so what somebody approved in spite of is
  // what was actually true when they pressed the button.
  const match = transition === 'approve' ? await refreshBillMatch(id) : null

  await setBillStatus(id, check.to, {
    ...(transition === 'query' ? { queryNote: note } : {}),
    ...(transition === 'resolve' ? { queryNote: null } : {}),
  })
  if (check.to === 'APPROVED') await setBillApprover(id, user.id)

  await recordAudit(
    'bill',
    id,
    `bill.${transition}`,
    {
      to: check.to,
      note: note ?? undefined,
      match: match?.status,
      variances: match?.flags.length ?? undefined,
    },
    user.id,
  )

  // An order that is fully delivered, fully invoiced and owed no credit has
  // nothing left to happen to it. Closing it here saves somebody going round
  // afterwards ticking off orders that finished weeks ago - and it is refused
  // while a return is still open, because closing the order would file away the
  // one screen showing that a supplier owes money.
  const autoClosed = check.to === 'APPROVED' ? await maybeCloseOrder(bill.orderId, user.id) : null

  return NextResponse.json({ ok: true, status: check.to, match, orderClosed: autoClosed })
}

async function maybeCloseOrder(orderId: string | null, userId: string): Promise<string | null> {
  if (!orderId) return null
  const order = await getOrder(orderId)
  if (!order) return null

  const [lines, openReturns] = await Promise.all([
    orderInvoicedLines(orderId),
    openReturnCount(orderId),
  ])
  if (!shouldAutoClose(order.status, lines, openReturns)) return null

  await setOrderStatus(orderId, 'CLOSED', { closeReason: 'Everything delivered and invoiced.' }, userId)
  await recordAudit(
    'order',
    orderId,
    'order.auto-closed',
    { reason: 'Everything delivered and invoiced.' },
    userId,
  )
  return order.number
}
