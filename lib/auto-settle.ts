import { closeOutcome, type InvoicedLine } from './billing'
import { scaled } from './totals'
import type { PoBillStatus, PoMatchStatus, PoStatus } from './types'

// When a customer's order is Completed, whether the supplier's side of it can be
// closed off without anybody looking: the decision, as a pure function of facts.
//
// It is deliberately stricter than anything a person does by hand. A person
// approving a bill can accept a variance, and that is theirs to decide; nothing
// automatic gets to. The bar is "there is nothing here a person would have
// stopped to think about":
//
//  - at least one live (not void) invoice, and none of them queried;
//  - every one of them clean on the three-way match, which is the owner's own
//    tolerance for what "agrees" means;
//  - together they come to the order's total to the PENNY - the match tolerates
//    a couple of percent on a unit price, and a couple of percent of an
//    approved payment is somebody's money;
//  - the order itself is in a state `closeOutcome` would close: delivered (or a
//    drop-ship that has gone out), every line invoiced in full, no return still
//    waiting on its credit.
//
// Everything else comes back as a sentence, so the log says why an order was
// left alone and the sweep can try it again tomorrow.

export type SettleBill = {
  id: string
  status: PoBillStatus
  total: string
  matchStatus: PoMatchStatus
}

export type SettleFacts = {
  orderStatus: PoStatus
  orderTotal: string
  dropships: boolean
  lines: InvoicedLine[]
  openReturns: number
  bills: SettleBill[]
}

export type SettleVerdict = { ok: true; approve: string[] } | { ok: false; reason: string }

/** Statuses an order can be in and still be closed off automatically. PENDING_CLOSE
 *  is the usual one; RECEIVED is an invoice somebody typed in; the middle three
 *  are a drop-ship, which `closeOutcome` itself decides about. */
export const AUTO_SETTLE_STATUSES: readonly PoStatus[] = [
  'RECEIVED',
  'PENDING_CLOSE',
  'SENT',
  'ACKNOWLEDGED',
  'PART_RECEIVED',
]

export function autoSettleVerdict(facts: SettleFacts): SettleVerdict {
  const live = facts.bills.filter((b) => b.status !== 'VOID')
  if (live.length === 0) return { ok: false, reason: 'There is no bill on it yet.' }

  if (live.some((b) => b.status === 'QUERIED')) return { ok: false, reason: 'A bill on it is queried.' }

  if (live.some((b) => b.matchStatus !== 'MATCHED')) {
    return { ok: false, reason: 'A bill on it does not agree with the order.' }
  }

  const billed = live.reduce((sum, b) => sum + scaled(b.total, 2), 0)
  if (billed !== scaled(facts.orderTotal, 2)) {
    return { ok: false, reason: 'The bills do not come to exactly the order total.' }
  }

  // Judged as the RECEIVED order it was before it went to PENDING_CLOSE:
  // `closeOutcome` only closes an order that has arrived, and that status is the
  // one a supplier's own invoice moves a delivered order into.
  const judged = facts.orderStatus === 'PENDING_CLOSE' ? 'RECEIVED' : facts.orderStatus
  if (closeOutcome(judged, facts.lines, facts.openReturns, 0, facts.dropships) !== 'CLOSED') {
    return { ok: false, reason: 'The order is not fully delivered and invoiced, or a return is still open.' }
  }

  return { ok: true, approve: live.filter((b) => b.status === 'DRAFT').map((b) => b.id) }
}
