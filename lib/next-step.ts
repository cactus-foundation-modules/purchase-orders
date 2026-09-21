import type { PoStatus } from './types'

// The next piece of PAPERWORK an order is waiting for.
//
// An order that has gone out collects documents in a fixed order, and at any
// moment exactly one of them is the one somebody is waiting on: their proforma,
// then our proof that it was paid, then their acknowledgement, then their
// invoice. The order screen puts that one thing on the solid button in the bar,
// so opening an order answers "what happens next" without anybody reading it.
//
// Derived, never stored - the same bargain as lib/standing.ts. Every fact it is
// made of is already a column somebody else writes.

export type PoPaperworkStep =
  /** On proforma terms, and their invoice has not turned up. */
  | 'PROFORMA'
  /** Their proforma is here and nobody has paid it. */
  | 'PAYMENT'
  /** They have not confirmed the order. */
  | 'ACKNOWLEDGEMENT'
  /** Confirmed, and they have not invoiced it. */
  | 'INVOICE'

export type PoPaperworkFacts = {
  status: PoStatus
  proformaRequired: boolean
  proformaReceived: boolean
  proformaPaid: boolean
  /** They confirmed it, with a document or without one. */
  acknowledged: boolean
  /** Whether everything still wanted on the order has been invoiced, on bills
   *  that have not been voided. */
  fullyInvoiced: boolean
}

/** The states in which the supplier is holding the order and the paperwork is
 *  still moving. A draft has not gone anywhere; an order on hold is waiting on
 *  us; pending-close, closed and cancelled are past it. */
const LIVE: readonly PoStatus[] = ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'RECEIVED']

export function nextPaperworkStep(facts: PoPaperworkFacts): PoPaperworkStep | null {
  if (!LIVE.includes(facts.status)) return null

  if (facts.proformaRequired && !facts.proformaPaid) {
    return facts.proformaReceived ? 'PAYMENT' : 'PROFORMA'
  }
  // Only while it still reads "Sent". Goods turning up is confirmation enough,
  // and asking for an acknowledgement of an order already on the shelf is asking
  // somebody to chase a piece of paper for its own sake.
  if (facts.status === 'SENT' && !facts.acknowledged) return 'ACKNOWLEDGEMENT'
  if (!facts.fullyInvoiced) return 'INVOICE'
  return null
}

/** What the button for each step says. Imperative, and in their words. */
export const PAPERWORK_STEP_LABELS: Record<PoPaperworkStep, string> = {
  PROFORMA: 'Upload their proforma',
  PAYMENT: 'Upload proof of payment',
  ACKNOWLEDGEMENT: 'Upload their acknowledgement',
  INVOICE: 'Enter their invoice',
}
