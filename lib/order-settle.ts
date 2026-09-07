import { closeOutcome, type CloseOutcome } from './billing'
import { openReturnCount, orderInvoicedLines, unsettledBillCount } from './bills'
import { getOrder, setOrderStatus } from './db'
import { recordAudit } from './audit'

// Where an order goes once there is nothing left to happen to it.
//
// One function, three callers, and that is the point of it living here rather
// than in whichever route noticed first. An order finishes when the last thing
// happens to it, and the last thing is any of three:
//
//  - somebody here approves the last invoice on it;
//  - a supplier files the last invoice through their own link;
//  - the last delivery is booked in, on an order the invoices got to first.
//
// Miss any one of those and an order sits at "received" for ever with everybody
// finished with it, which is the state this whole exercise is about.
//
// It never moves an order that is not RECEIVED, never one with an open return on
// it, and never one whose lines are not all invoiced - lib/billing.ts holds
// those rules and is the only place they are written down.

export type Settled = { status: Exclude<CloseOutcome, null>; number: string }

/**
 * Put the order to bed if it is ready, and say where it landed.
 *
 * `userId` is null where nobody here did it: the supplier's own link moves an
 * order to PENDING_CLOSE, and stamping somebody's name on that would put a
 * person's id against an action they were not part of.
 *
 * Null back means it was not ready, which is the ordinary answer and not a
 * failure. Every caller treats it as "nothing to say".
 */
export async function settleOrder(
  orderId: string | null,
  userId: string | null,
): Promise<Settled | null> {
  if (!orderId) return null
  const order = await getOrder(orderId)
  if (!order) return null

  const [lines, openReturns, unsettled] = await Promise.all([
    orderInvoicedLines(orderId),
    openReturnCount(orderId),
    unsettledBillCount(orderId),
  ])

  const outcome = closeOutcome(order.status, lines, openReturns, unsettled)
  if (!outcome) return null

  // Only CLOSED carries a reason. PENDING_CLOSE is not a closure and must not
  // write close_reason: an order that is later reopened would otherwise read as
  // having been closed for a reason nobody gave.
  await setOrderStatus(
    orderId,
    outcome,
    outcome === 'CLOSED' ? { closeReason: 'Everything delivered and invoiced.' } : {},
    userId,
  )
  await recordAudit(
    'order',
    orderId,
    outcome === 'CLOSED' ? 'order.auto-closed' : 'order.pending-close',
    {
      reason:
        outcome === 'CLOSED'
          ? 'Everything delivered and invoiced.'
          : 'Everything delivered and invoiced, and the invoices are waiting to be checked.',
      unsettledBills: unsettled || undefined,
    },
    userId,
  )

  return { status: outcome, number: order.number }
}
