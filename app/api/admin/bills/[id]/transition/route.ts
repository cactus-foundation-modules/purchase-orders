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
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { sendBillToBooks, sendBillVoidToBooks } from '@/modules/purchase-orders/lib/book-handoff'

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

  // The books, where there are any and the owner asked for it. Never fails the
  // transition: the bill is approved, or it is withdrawn, and a bookkeeping
  // module that is mid-VAT-return or simply broken does not get to undo that.
  // What it said is stored on the bill, and the screen offers the button again.
  const books = await handOver(transition, check.to, id, bill.status, note)

  // An order that is fully delivered, fully invoiced and owed no credit has
  // nothing left to happen to it. Closing it here saves somebody going round
  // afterwards ticking off orders that finished weeks ago - and it is refused
  // while a return is still open, because closing the order would file away the
  // one screen showing that a supplier owes money.
  const autoClosed = check.to === 'APPROVED' ? await maybeCloseOrder(bill.orderId, user.id) : null

  // Re-read rather than assume: the handoff is what promotes an approved bill to
  // "in the books", and the screen has to be told which of the two it ended on.
  const after = books ? await getBill(id) : null

  return NextResponse.json({
    ok: true,
    status: after?.status ?? check.to,
    match,
    orderClosed: autoClosed,
    books,
  })
}

/**
 * The bookkeeping handoff for one transition, or null where there is none.
 *
 * Approving files the invoice. Voiding takes it back out again, but only when it
 * was actually in there - a draft that never reached a set of books has nothing
 * to withdraw, and telling the books about it would be a message about an entry
 * that does not exist.
 */
async function handOver(
  transition: PoBillTransition,
  to: string,
  billId: string,
  from: string,
  note: string | null,
) {
  if (transition === 'approve') {
    const config = await getPoConfigCached()
    if (!config.postApprovedBillsToBooks) return null
    return (await sendBillToBooks(billId)).outcome
  }
  if (to === 'VOID' && from === 'POSTED') {
    return sendBillVoidToBooks(billId, note ?? 'Withdrawn in Purchase Orders.')
  }
  return null
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
