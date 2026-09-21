import { proformaStage, type PoStageFacts } from './proforma-stage'
import type { SourceKind } from './types'

// Where an order stands, in a sentence, worked out from the order every time it
// is drawn.
//
// This exists because the sentence used to be STORED. An order drafted off a
// customer order carried an internal note reading "nothing has been sent to the
// supplier", written once when it was drafted - and it went on saying so after
// the order had been emailed, confirmed and delivered. Anything that describes
// where an order has got to is derived here, from the columns that actually
// move; a note is for what somebody wanted to remember.

export type PoStandingTone = 'info' | 'success' | 'warning' | 'danger'

export type PoStanding = {
  tone: PoStandingTone
  /** Where the order is. One sentence, always present. */
  headline: string
  /** Where it came from, or what is holding it up. Null when there is nothing
   *  worth adding. */
  detail: string | null
}

export type PoStandingFacts = PoStageFacts & {
  approvalRequired: boolean
  sentAt: string | null
  sourceKind: SourceKind
  /** The customer order it was drafted off, where there was one. */
  sourceOrderNumber: string | null
  /** Drafted by the money landing, or by the nightly job, rather than by
   *  somebody pressing a button. */
  raisedAutomatically: boolean
  cancelReason: string | null
  closeReason: string | null
}

/** Where a draft came from. Only said while it is still a draft: once an order
 *  has gone, how it was first typed up is history, and the history card has it. */
function origin(facts: PoStandingFacts): string | null {
  if (facts.sourceKind === 'FROM_ORDER') {
    const from = facts.sourceOrderNumber ? `customer order ${facts.sourceOrderNumber}` : 'a customer order'
    return facts.raisedAutomatically
      ? `Drafted automatically when ${from} was paid for. Nobody has checked it yet, so give it a read before it goes.`
      : `Drafted from ${from}.`
  }
  if (facts.sourceKind === 'REORDER') {
    return facts.raisedAutomatically
      ? 'Drafted overnight from your reorder levels. Nobody has checked it yet, so give it a read before it goes.'
      : 'Drafted from your reorder levels.'
  }
  return null
}

/**
 * `when` formats a timestamp for whoever is reading. Passed in rather than done
 * here so this stays a pure function of the order - the screen already has a
 * formatter, and a test should not depend on the machine's locale.
 */
export function orderStanding(facts: PoStandingFacts, when: (iso: string) => string): PoStanding {
  const sent = facts.sentAt ? `Sent to the supplier ${when(facts.sentAt)}.` : 'Marked as sent to the supplier.'

  switch (facts.status) {
    case 'DRAFT': {
      // Back in draft after a hold is the one draft the supplier may already be
      // holding a copy of, and "nothing has been sent" would be untrue of it.
      if (facts.sentAt) {
        return {
          tone: 'warning',
          headline: `Back in draft. The supplier was last sent this order ${when(facts.sentAt)}, and has not seen anything changed since.`,
          detail: null,
        }
      }
      const approval = facts.approvalRequired
        ? 'It is over your approval threshold, so it needs approving before it can go out.'
        : null
      return {
        tone: facts.approvalRequired ? 'warning' : 'info',
        headline: 'A draft. Nothing has been sent to the supplier.',
        detail: [origin(facts), approval].filter(Boolean).join(' ') || null,
      }
    }
    case 'AWAITING_APPROVAL':
      return {
        tone: 'warning',
        headline: 'Waiting for somebody to approve it. Nothing has been sent to the supplier.',
        detail: origin(facts),
      }
    case 'APPROVED':
      return { tone: 'info', headline: 'Approved and ready to go. It has not been sent to the supplier yet.', detail: null }
    case 'SENT': {
      const stage = proformaStage(facts)
      if (stage === 'AWAITED') return { tone: 'info', headline: sent, detail: 'Waiting for their proforma invoice.' }
      if (stage === 'RECEIVED') {
        return { tone: 'warning', headline: sent, detail: 'Their proforma is here and has not been paid. This one is waiting on you.' }
      }
      if (stage === 'PAID') return { tone: 'info', headline: sent, detail: 'The proforma is paid. Waiting for them to confirm the order.' }
      return { tone: 'info', headline: sent, detail: 'Waiting for them to confirm it.' }
    }
    case 'ACKNOWLEDGED':
      return { tone: 'info', headline: 'The supplier has confirmed this order.', detail: 'Waiting for the goods.' }
    case 'PART_RECEIVED':
      return { tone: 'warning', headline: 'Some of this order has turned up.', detail: 'The rest is still due.' }
    case 'RECEIVED':
      return { tone: 'success', headline: 'Everything on this order has turned up.', detail: null }
    case 'PENDING_CLOSE':
      return {
        tone: 'warning',
        headline: 'The supplier says they have invoiced all of it.',
        detail: 'Check their invoices and approve them, then close the order.',
      }
    case 'CLOSED':
      return { tone: 'info', headline: 'Closed.', detail: facts.closeReason }
    case 'CANCELLED':
      return { tone: 'danger', headline: 'Cancelled.', detail: facts.cancelReason }
    case 'ON_HOLD':
      return {
        tone: 'warning',
        headline: 'On hold. Nothing moves on this order until it is taken off.',
        detail: facts.sentAt ? `The supplier was last sent it ${when(facts.sentAt)}.` : 'Nothing has been sent to the supplier.',
      }
  }
}
