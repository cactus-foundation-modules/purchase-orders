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
// It applies to SENT, and to ACKNOWLEDGED while the proforma is unpaid. The
// supplier's own link will not let them confirm an order on these terms until
// the money has moved, but their emailed sales order does exactly that whenever
// they send it - and a supplier who has accepted the order has acknowledged it
// (lib/inbound-run.ts moves it straight away). Dropping the stage there would
// lose the one badge that says money is owed, so an acknowledged order with its
// proforma unpaid says both. Once the proforma is paid the acknowledgement is
// the more useful fact on its own, and the proforma card carries the detail.

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
  if (!order.proformaRequired) return 'NONE'
  if (order.status === 'ACKNOWLEDGED') {
    if (order.proformaPaid) return 'NONE'
    return order.proformaReceived ? 'RECEIVED' : 'AWAITED'
  }
  if (order.status !== 'SENT') return 'NONE'
  if (order.proformaPaid) return 'PAID'
  return order.proformaReceived ? 'RECEIVED' : 'AWAITED'
}

const STAGE_LABELS: Record<Exclude<PoProformaStage, 'NONE'>, string> = {
  AWAITED: 'Waiting for proforma',
  RECEIVED: 'Proforma received',
  PAID: 'Proforma paid',
}

/** The same stages on an order they have already acknowledged. PAID never
 *  appears here: paid and acknowledged is plain "Acknowledged". */
const ACKNOWLEDGED_LABELS: Record<Exclude<PoProformaStage, 'NONE' | 'PAID'>, string> = {
  AWAITED: 'Acknowledged, proforma awaited',
  RECEIVED: 'Acknowledged, proforma to pay',
}

/** What the badge says: the ordinary status label, or where the order stands in
 *  the proforma dance while that is the only thing happening to it. */
export function orderStatusLabel(order: PoStageFacts): string {
  const stage = proformaStage(order)
  if (stage === 'NONE') return PO_STATUS_LABELS[order.status]
  if (order.status === 'ACKNOWLEDGED' && stage !== 'PAID') return ACKNOWLEDGED_LABELS[stage]
  return STAGE_LABELS[stage]
}

/** Whether the next move is OURS. Exactly one stage qualifies: their invoice is
 *  here and nobody has paid it, which is the state the whole card exists to make
 *  visible - and the one worth a colour in a list of forty orders. */
export function proformaWaitsOnUs(order: PoStageFacts): boolean {
  return proformaStage(order) === 'RECEIVED'
}
