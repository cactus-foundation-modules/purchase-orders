import { PO_STATUS_LABELS, type PoStatus } from '@/modules/purchase-orders/lib/types'

// Where an order on proforma terms has actually got to.
//
// The status column says SENT for the whole of the proforma dance, and rightly:
// the state MACHINE has one transition there and nothing about waiting for an
// invoice, paying it, or being told it arrived changes what an order may do
// next. Widening the enum would put four more values into every transition
// table, every filter, every report and the CHECK constraint, to describe
// something three columns on the order already record exactly.
//
// So the stage is derived, not stored, and only ever changes what the badge
// SAYS. "Sent" on an order that has been sitting with an unpaid proforma for a
// fortnight is true and useless; "Proforma received" is the same fact with the
// bit somebody can act on left in.
//
// It applies to SENT and nothing else. Once a supplier has acknowledged an order
// - which on these terms they cannot do until the money has moved - the
// acknowledgement is the more useful fact, and the proforma card on the order
// carries the detail either way.

export type PoProformaStage =
  /** Not on proforma terms, or not at a point where the proforma is the story. */
  | 'NONE'
  /** On proforma terms, sent, and their invoice has not turned up. */
  | 'AWAITED'
  /** Their invoice is here and nobody has paid it. The one that is on us. */
  | 'RECEIVED'
  /** Paid, and now we are waiting on them again. */
  | 'PAID'

/** The three facts the stage is made of, as both the list and the order carry
 *  them. Booleans rather than the raw columns: "received" is a media id OR a
 *  timestamp, and that is decided once, in lib/db.ts, rather than by each screen
 *  remembering to check both. */
export type PoStageFacts = {
  status: PoStatus
  proformaRequired: boolean
  proformaReceived: boolean
  proformaPaid: boolean
}

export function proformaStage(order: PoStageFacts): PoProformaStage {
  if (!order.proformaRequired || order.status !== 'SENT') return 'NONE'
  if (order.proformaPaid) return 'PAID'
  return order.proformaReceived ? 'RECEIVED' : 'AWAITED'
}

const STAGE_LABELS: Record<Exclude<PoProformaStage, 'NONE'>, string> = {
  AWAITED: 'Waiting for proforma',
  RECEIVED: 'Proforma received',
  PAID: 'Proforma paid',
}

/** What the badge says: the ordinary status label, or where the order stands in
 *  the proforma dance while that is the only thing happening to it. */
export function orderStatusLabel(order: PoStageFacts): string {
  const stage = proformaStage(order)
  return stage === 'NONE' ? PO_STATUS_LABELS[order.status] : STAGE_LABELS[stage]
}

/** Whether the next move is OURS. Exactly one stage qualifies: their invoice is
 *  here and nobody has paid it, which is the state the whole card exists to make
 *  visible - and the one worth a colour in a list of forty orders. */
export function proformaWaitsOnUs(order: PoStageFacts): boolean {
  return proformaStage(order) === 'RECEIVED'
}
