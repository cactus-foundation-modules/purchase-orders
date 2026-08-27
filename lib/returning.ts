import { lineAmounts, fromPence, scaled } from './totals'
import type { PoAccess } from './permissions'
import type { PoReturnStatus, PoReturnableLine } from './types'

// The arithmetic and the rules of sending goods back, kept away from the
// database and the screens so both use exactly the same answer.
//
// Returns are the mirror image of receiving with one difference that changes
// everything: over-receipt is allowed and flagged, because a supplier really can
// send eleven of something you ordered ten of - but over-RETURN is nonsense. You
// cannot send back what never turned up, and a return note claiming otherwise is
// a credit claim the supplier will refuse and an argument nobody needed.

/** What is left on an order line to send back: what arrived, less what has
 *  already gone. Never below zero. */
export function returnableQty(line: { qtyReceived: string | number; qtyReturned: string | number }): number {
  return Math.max(0, Number(line.qtyReceived) - Number(line.qtyReturned))
}

export type ReturnLineDraft = {
  orderLineId: string
  qty: number
}

export type OverReturnProblem = {
  orderLineId: string
  description: string
  /** How much of this line ever turned up. */
  received: number
  /** How much of it has already gone back on an earlier return. */
  alreadyReturned: number
  /** How much this note is trying to send. */
  returning: number
  /** The most it could send. */
  allowed: number
}

/**
 * Which lines this return note is trying to send back more of than ever arrived.
 *
 * Unlike over-receipt, this is a REFUSAL rather than a flag. The whole document
 * is a claim on the supplier for money; one that claims for twelve when ten were
 * delivered is not a document anybody wants to have sent.
 */
export function overReturnProblems(
  lines: {
    id: string
    description: string
    qtyReceived: string
    qtyReturned: string
  }[],
  drafts: ReturnLineDraft[],
): OverReturnProblem[] {
  const byId = new Map(lines.map((l) => [l.id, l]))
  const problems: OverReturnProblem[] = []

  for (const draft of drafts) {
    const line = byId.get(draft.orderLineId)
    if (!line) continue
    const returning = Number(draft.qty) || 0
    if (returning <= 0) continue

    const received = Number(line.qtyReceived) || 0
    const alreadyReturned = Number(line.qtyReturned) || 0
    const allowed = returnableQty(line)
    // Rounded to the three places the column holds, so a perfectly exact return
    // of everything left is not refused by a floating-point crumb.
    if (round3(returning) <= round3(allowed)) continue

    problems.push({
      orderLineId: line.id,
      description: line.description,
      received,
      alreadyReturned,
      returning,
      allowed: round3(allowed),
    })
  }
  return problems
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

// ---------------------------------------------------------------------------
// The money
// ---------------------------------------------------------------------------

export type ReturnTotalsLine = {
  qty: string | number
  unitCost: string | number
  taxRatePercent?: string | number | null
}

export type ReturnTotals = {
  /** Net of everything going back. */
  subtotal: string
  taxAmount: string
  /** What the supplier is being asked to credit: net plus its tax. */
  creditExpected: string
  lineTotals: string[]
}

/**
 * What a return note is worth.
 *
 * The same file the order uses (`lib/totals.ts`), deliberately: a credit claim
 * that rounds differently from the order it is claiming against is an argument
 * with the supplier over a penny, every time. No order-level discount and no
 * carriage - a return has neither, and inventing an apportioned share of the
 * original carriage would be a number nobody agreed to.
 *
 * Always EXCLUSIVE. A return line carries the net cost from the order line and
 * its own tax rate, whatever tax mode the order was typed in: by the time it is
 * on the order line, the net has already been worked out.
 */
export function returnTotals(lines: ReturnTotalsLine[]): ReturnTotals {
  const amounts = lines.map((line) => lineAmounts(line, 'EXCLUSIVE'))
  const net = amounts.reduce((sum, a) => sum + a.net, 0)
  const tax = amounts.reduce((sum, a) => sum + a.tax, 0)
  return {
    subtotal: fromPence(net),
    taxAmount: fromPence(tax),
    creditExpected: fromPence(net + tax),
    lineTotals: amounts.map((a) => a.lineTotal),
  }
}

/** What is still owed on a return: what was claimed, less what has been
 *  credited. Never below zero - a supplier who over-credits has done something
 *  worth looking at, not something worth printing as a negative. */
export function creditOutstanding(expected: string | number, received: string | number): string {
  return fromPence(Math.max(0, scaled(expected, 2) - scaled(received, 2)))
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------
//
// Shorter than the order's, because a return has one job: goods leave, a credit
// is promised, the credit arrives. What it shares with the order is the shape -
// one table, one guard, every move written to the audit log by the caller.

export type PoReturnTransition = 'send' | 'promised' | 'credited' | 'close' | 'cancel' | 'reopen'

type Rule = {
  from: readonly PoReturnStatus[]
  to: PoReturnStatus
  /** Raising and sending goods back is the goods-in desk's job; agreeing that
   *  the money has arrived is the bookkeeping one. */
  needs: keyof Pick<PoAccess, 'canReceive' | 'canBills'>
  label: string
}

export const RETURN_TRANSITIONS: Record<PoReturnTransition, Rule> = {
  send: { from: ['DRAFT'], to: 'SENT', needs: 'canReceive', label: 'Sent to supplier' },
  promised: { from: ['SENT'], to: 'CREDIT_EXPECTED', needs: 'canReceive', label: 'Credit promised' },
  // Straight from SENT as well as from CREDIT_EXPECTED: plenty of suppliers
  // simply send the credit note without promising anything first, and making
  // somebody click "promised" about a credit already in their hand is silly.
  credited: { from: ['SENT', 'CREDIT_EXPECTED'], to: 'CREDITED', needs: 'canBills', label: 'Credited' },
  close: { from: ['SENT', 'CREDIT_EXPECTED', 'CREDITED'], to: 'CLOSED', needs: 'canReceive', label: 'Closed' },
  cancel: { from: ['DRAFT', 'SENT', 'CREDIT_EXPECTED'], to: 'CANCELLED', needs: 'canReceive', label: 'Cancelled' },
  reopen: { from: ['CLOSED'], to: 'CREDIT_EXPECTED', needs: 'canReceive', label: 'Reopened' },
}

export type ReturnTransitionCheck =
  | { ok: true; to: PoReturnStatus; label: string }
  | { ok: false; reason: string }

function words(status: PoReturnStatus): string {
  return status.toLowerCase().replace(/_/g, ' ')
}

export function checkReturnTransition(
  transition: PoReturnTransition,
  from: PoReturnStatus,
  access: PoAccess,
): ReturnTransitionCheck {
  const rule = RETURN_TRANSITIONS[transition]
  if (!rule) return { ok: false, reason: 'That is not something a return can do.' }
  if (!access[rule.needs]) return { ok: false, reason: 'You do not have permission to do that.' }
  if (!rule.from.includes(from)) {
    return { ok: false, reason: `A return that is ${words(from)} cannot be ${rule.label.toLowerCase()}.` }
  }
  return { ok: true, to: rule.to, label: rule.label }
}

/** Which moves this user could make on a return in this state, for the buttons. */
export function availableReturnTransitions(from: PoReturnStatus, access: PoAccess): PoReturnTransition[] {
  return (Object.keys(RETURN_TRANSITIONS) as PoReturnTransition[]).filter(
    (t) => checkReturnTransition(t, from, access).ok,
  )
}

/** Whether a return in this state may still be edited. A draft is; anything the
 *  supplier is holding a copy of is not - it is cancelled and raised again. */
export function isReturnEditable(status: PoReturnStatus): boolean {
  return status === 'DRAFT'
}

/** Whether the note may be emailed to the supplier right now. A cancelled one
 *  never; a closed one never; everything else may be re-sent, because "can you
 *  send that again, we cannot find it" is most of what a returns desk does. */
export function canSendReturn(status: PoReturnStatus): boolean {
  return status === 'DRAFT' || status === 'SENT' || status === 'CREDIT_EXPECTED' || status === 'CREDITED'
}

/**
 * Whether goods on a return may still be taken off a stock count.
 *
 * Not a draft - nothing has left the building yet - and not a cancelled one,
 * where nothing ever will. The rest of the states all mean the goods have gone.
 */
export function isReturnStockable(status: PoReturnStatus): boolean {
  return status !== 'DRAFT' && status !== 'CANCELLED'
}

// ---------------------------------------------------------------------------
// Checking a return note before it is written
// ---------------------------------------------------------------------------

export type ReturnDraft = { orderLineId: string; receiptLineId: string | null; qty: string }

export type ValidatedReturn =
  | { ok: false; reason: string }
  | {
      ok: true
      lines: {
        orderLineId: string
        receiptLineId: string | null
        qty: string
        unitCost: string
        taxRatePercent: string
      }[]
    }

/**
 * Every line has to belong to this order, have actually turned up, and not be
 * asking for more than is left.
 *
 * The screen only offers this order's lines, but the ids come off the wire and
 * po_return_lines has no idea which order its parent belongs to. The costs are
 * taken from the ORDER line here rather than from the browser: what a return is
 * worth is not something the person filling the form gets to type.
 */
export function validateReturnDrafts(
  returnable: PoReturnableLine[],
  drafts: ReturnDraft[],
): ValidatedReturn {
  const byId = new Map(returnable.map((l) => [l.orderLineId, l]))
  if (drafts.some((d) => !byId.has(d.orderLineId))) {
    return { ok: false, reason: 'One of those lines is not on this order, or nothing on it has been delivered yet.' }
  }

  const problems = overReturnProblems(
    returnable.map((l) => ({
      id: l.orderLineId,
      description: l.description,
      qtyReceived: l.qtyReceived,
      qtyReturned: l.qtyReturned,
    })),
    drafts.map((d) => ({ orderLineId: d.orderLineId, qty: Number(d.qty) })),
  )
  if (problems.length > 0) {
    const first = problems[0]!
    return {
      ok: false,
      reason: `You cannot send back more than turned up. ${first.description} had ${first.allowed} left to return, not ${first.returning}.`,
    }
  }

  return {
    ok: true,
    lines: drafts.map((draft) => {
      const line = byId.get(draft.orderLineId)!
      // A receipt line that is not this order line's own is dropped rather than
      // stored: it would put the wrong delivery number on the note and, worse,
      // settle the stock question off somebody else's paperwork.
      const receipt = line.receipts.find((r) => r.receiptLineId === draft.receiptLineId)
      return {
        orderLineId: draft.orderLineId,
        receiptLineId: receipt?.receiptLineId ?? null,
        qty: draft.qty,
        unitCost: line.unitCost,
        taxRatePercent: line.taxRatePercent,
      }
    }),
  }
}
