import type { PoOrderLine, PoStatus } from './types'

// The arithmetic of booking goods in, kept away from the database and the
// screens so both can use exactly the same answer.
//
// Two numbers matter per line and neither is stored: what is still outstanding
// (ordered, less anything cancelled, less what has already turned up) and
// whether what is being accepted now takes the total past what the site is
// willing to over-receive. Everything else on the receiving screen is dressing.

/** Ordered, less anything cancelled. What the supplier is actually on the hook for. */
export function liveQty(line: Pick<PoOrderLine, 'qty' | 'qtyCancelled'>): number {
  return Math.max(0, Number(line.qty) - Number(line.qtyCancelled))
}

/** What is still expected on a line, never below zero. */
export function outstanding(line: Pick<PoOrderLine, 'qty' | 'qtyCancelled' | 'qtyReceived'>): number {
  return Math.max(0, liveQty(line) - Number(line.qtyReceived))
}

export type ReceiptLineDraft = {
  orderLineId: string
  qtyAccepted: number
  qtyRejected: number
}

export type OverReceiptFlag = {
  orderLineId: string
  description: string
  /** Ordered less cancelled. */
  ordered: number
  /** Already booked in before this delivery. */
  alreadyReceived: number
  /** Being accepted now. */
  accepting: number
  /** How far past the ordered quantity this delivery takes the line. */
  overBy: number
  /** The most this line could take without being flagged, tolerance included. */
  allowed: number
}

/**
 * Which lines this delivery would over-receive, past the site's tolerance.
 *
 * Over-receipt is ALLOWED - suppliers send full cases, and refusing the two
 * spare is a fine way to be left with a receipt that does not match the pallet.
 * It is flagged, not blocked: the person booking it in sees it, the audit trail
 * records it, and the bill will have to answer for it at the three-way match.
 *
 * A tolerance of 0 means any excess at all is worth mentioning, which is the
 * sensible default. Rejected quantities never count: they arrived and went
 * straight back, so they were never received.
 */
export function overReceiptFlags(
  lines: Pick<PoOrderLine, 'id' | 'description' | 'qty' | 'qtyCancelled' | 'qtyReceived'>[],
  drafts: ReceiptLineDraft[],
  tolerancePercent: number,
): OverReceiptFlag[] {
  const tolerance = Math.max(0, Number(tolerancePercent) || 0)
  const byId = new Map(lines.map((l) => [l.id, l]))
  const flags: OverReceiptFlag[] = []

  for (const draft of drafts) {
    const line = byId.get(draft.orderLineId)
    if (!line) continue
    const accepting = Number(draft.qtyAccepted) || 0
    if (accepting <= 0) continue

    const ordered = liveQty(line)
    const alreadyReceived = Number(line.qtyReceived) || 0
    const allowed = ordered * (1 + tolerance / 100)
    const total = alreadyReceived + accepting
    // Rounded to the same three decimal places the column holds, so a tolerance
    // that works out to 10.000000000000002 does not flag a delivery of ten.
    if (round3(total) <= round3(allowed)) continue

    flags.push({
      orderLineId: line.id,
      description: line.description,
      ordered,
      alreadyReceived,
      accepting,
      overBy: round3(total - ordered),
      allowed: round3(allowed),
    })
  }
  return flags
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Whether goods can be booked in against an order in this state at all. */
export function isReceivable(status: PoStatus): boolean {
  return (
    status === 'SENT' ||
    status === 'ACKNOWLEDGED' ||
    status === 'PART_RECEIVED' ||
    status === 'RECEIVED' ||
    status === 'ON_HOLD'
  )
}

/**
 * What an order's status should become once its deliveries have been counted,
 * or null to leave it exactly as it is.
 *
 * `computed` is what lib/progress.ts made of the lines. The rest is about not
 * trampling a decision somebody made deliberately: an order put on hold stays on
 * hold whatever turns up, and a closed or cancelled one is nobody's business
 * here. An order that had deliveries and now has none goes back to whichever of
 * sent or acknowledged it was, rather than sitting at "part received" with
 * nothing received.
 */
export function statusAfterReceipts(
  current: PoStatus,
  computed: 'RECEIVED' | 'PART_RECEIVED' | null,
  acknowledged: boolean,
): PoStatus | null {
  if (current === 'ON_HOLD' || current === 'CLOSED' || current === 'CANCELLED') return null
  if (current !== 'SENT' && current !== 'ACKNOWLEDGED' && current !== 'PART_RECEIVED' && current !== 'RECEIVED') {
    return null
  }
  const next = computed ?? (acknowledged ? 'ACKNOWLEDGED' : 'SENT')
  return next === current ? null : next
}
