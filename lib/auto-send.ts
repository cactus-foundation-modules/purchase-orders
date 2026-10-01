import { calendarDateIn, formatInSiteTimezone } from '@/lib/config/timezone'
import { canSend } from './lifecycle'
import type { PoStatus, SupplierStatus } from './types'

// Whether an automatic draft may go to its supplier without anybody pressing
// Send - every rule, as pure functions of facts read elsewhere, so what counts
// as "sure enough" is pinned by a test rather than by reading the job.
//
// Real use is the reason this file is a list of refusals rather than a switch.
// Of the first automatic drafts on a live install, most had a price changed by
// hand before they went: a draft that is usually wrong must not be sent by a
// machine on the strength of a switch alone. So a supplier has to be switched
// on by the owner, the site-wide switch has to be on, the draft has to have
// waited out its hold untouched, and then every one of these has to pass. Any
// one failing leaves it as a draft, with the sentence saying why, for a person.
//
// Nothing here reads the database. lib/auto-send-run.ts gathers the facts and
// does the writing; lib/send-run.ts does the sending, the same way the button
// does.

/** What is printed where an approver's name would be, on an order the job
 *  sent: on the document under "Authorised by", on the order screen, and in
 *  the orders export. The truth, rather than a blank or a made-up name. */
export const SENT_AUTOMATICALLY = 'Sent automatically'

/** How many of a supplier's latest automatic drafts the edit record looks
 *  back over. */
export const RECORD_SIZE = 10

/** How long the job's claim on a draft stands. A run is a minute at most, so
 *  a claim older than this belongs to a run that died. */
export const CLAIM_MINUTES = 10

/** What a person is told when they try to change or send a draft the job is
 *  sending at that very moment. */
export const BEING_SENT_AUTOMATICALLY = 'This draft is being sent automatically right now. Look again in a minute.'

/** How many times mail that would not go is tried before a person is told. */
export const MAX_SEND_ATTEMPTS = 3

/** When a draft queued at `createdAt` becomes due. */
export function autoSendDueAt(createdAt: string, holdMinutes: number): string {
  const start = new Date(createdAt).getTime()
  if (Number.isNaN(start)) return createdAt
  return new Date(start + Math.max(0, holdMinutes) * 60_000).toISOString()
}

/** The note a draft carries once a person has changed it. Permanent: a person
 *  has touched it, so a person sends it. */
export function heldNote(personName: string | null): string {
  const who = personName?.trim() || 'somebody'
  return `Changed by ${who}, so a person sends it.`
}

export type QueueFacts = {
  /** `autoSendEnabled` in settings. */
  masterOn: boolean
  /** The supplier's own switch. */
  supplierOn: boolean
  /** Lines on the customer order that could not be drafted at all. */
  skippedLines: number
  customerOrderNumber: string
}

export type QueueDecision = { state: 'QUEUED'; note: null } | { state: 'REFUSED'; note: string } | null

/**
 * Where a freshly raised AUTOMATIC draft goes: into the queue, straight to
 * refused, or nowhere at all (null - it was never going to be sent by itself,
 * and is an ordinary draft exactly as before this existed).
 *
 * A customer order with something on it that could not be drafted is refused
 * at once rather than at send time: the run that knew is this one, and the
 * draft beside a gap is the one a person most needs to read.
 */
export function queueDecision(facts: QueueFacts): QueueDecision {
  if (!facts.masterOn || !facts.supplierOn) return null
  if (facts.skippedLines > 0) {
    const what = facts.skippedLines === 1 ? 'One thing' : `${facts.skippedLines} things`
    return {
      state: 'REFUSED',
      note: `${what} on customer order ${facts.customerOrderNumber} could not be drafted, so a person should check this before it goes.`,
    }
  }
  return { state: 'QUEUED', note: null }
}

/** One line of the draft, as the price check needs it. */
export type SendLineFacts = {
  description: string
  unitCost: string
  /** Against the supplier's current price list, where lists are switched on:
   *  MATCH the list prices this code at exactly this, DIFFERENT it prices it at
   *  something else, MISSING no list names the code (or the line has none).
   *  DISCONTINUED the list prices it but says the supplier has stopped making
   *  it. NOT_CHECKED where lists are off. */
  catalogue: 'MATCH' | 'DIFFERENT' | 'MISSING' | 'DISCONTINUED' | 'NOT_CHECKED'
}

/** The customer order behind the draft, re-read at send time. */
export type SendCustomerFacts =
  | { readable: false; orderNumber: string | null }
  | {
      readable: true
      orderNumber: string
      status: string
      /** Shop's `payment_status`, where it could be read. */
      paymentStatus: string | null
      /** Products on the draft whose customer line now owes fewer than the
       *  draft orders - refunded in part since it was drafted. */
      shortfall: string[]
    }

export type SendFacts = {
  masterOn: boolean
  supplier: { name: string; autoSend: boolean; status: SupplierStatus; hasEmail: boolean } | null
  order: {
    status: PoStatus
    approvalRequired: boolean
    /** Whether the total needs approving under TODAY's settings - a threshold
     *  lowered since it was drafted counts. */
    approvalNowRequired: boolean
    sentAt: string | null
    autoSendState: string | null
  }
  /** Null for a draft not bought for a customer order - which the queue never
   *  holds, and is refused if it somehow does. */
  customer: SendCustomerFacts | null
  lines: SendLineFacts[]
}

/** Customer-order statuses in which buying the goods in is right: paid for and
 *  being got ready, on its way, done, or refunded only in part (the shortfall
 *  check below covers the part). An allow-list rather than a block-list, so
 *  PENDING (not paid), ON_HOLD, and any status shop adds later are refused
 *  until somebody decides otherwise. Shop's `shp_orders.status` values. */
const BUYABLE_CUSTOMER_STATUSES = new Set(['PROCESSING', 'SHIPPED', 'COMPLETED', 'PARTIALLY_REFUNDED'])

/** Shop's `payment_status` values that mean the money is here. */
const PAID_CUSTOMER_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED'])

function customerStatusWords(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ')
}

/**
 * Why the job will not send this draft, in a sentence for the owner, or null
 * when it may go.
 *
 * Order matters only for which sentence is given when several apply: the
 * switches first (the owner's own say), then the order itself, then the
 * customer, then the money.
 */
export function sendRefusal(facts: SendFacts): string | null {
  const { order, supplier, customer } = facts

  if (order.autoSendState !== 'QUEUED') return 'It is no longer waiting to be sent automatically.'
  if (!facts.masterOn) return 'Sending drafts automatically has been switched off in settings since this was drafted.'
  if (!supplier) return 'The supplier is no longer on your list.'
  if (!supplier.autoSend) return `Automatic sending has been switched off for ${supplier.name} since this was drafted.`
  if (supplier.status !== 'ENABLED') {
    return `${supplier.name} is ${supplier.status === 'ON_HOLD' ? 'on hold' : 'switched off'} on your supplier list.`
  }

  // Amendments are never automatic: the supplier already holds a copy, and
  // what changed is somebody's decision to explain.
  if (order.sentAt) return 'This order has been sent before, and a change to it is never sent automatically.'
  if (order.status !== 'DRAFT') {
    return `It is ${order.status.toLowerCase().replace(/_/g, ' ')} now rather than a draft, so a person decides what happens next.`
  }

  if (!customer) return 'It was not drafted for a customer order, so it is not one to send automatically.'
  if (!customer.readable) {
    const which = customer.orderNumber ? `Customer order ${customer.orderNumber}` : 'The customer order'
    return `${which} could not be read just now, so nobody can say it is still wanted.`
  }
  if (customer.status === 'CANCELLED' || customer.status === 'REFUNDED') {
    return `Customer order ${customer.orderNumber} has been ${customer.status.toLowerCase()} since this was drafted.`
  }
  if (!BUYABLE_CUSTOMER_STATUSES.has(customer.status)) {
    return `Customer order ${customer.orderNumber} is ${customerStatusWords(customer.status)}, so a person decides whether to buy for it.`
  }
  if (customer.paymentStatus !== null && !PAID_CUSTOMER_STATUSES.has(customer.paymentStatus)) {
    return `Customer order ${customer.orderNumber}'s payment is ${customerStatusWords(customer.paymentStatus)}, so a person decides whether to buy for it.`
  }
  if (customer.shortfall.length > 0) {
    return `Part of customer order ${customer.orderNumber} has been refunded since this was drafted (${customer.shortfall.join(', ')}).`
  }

  // The job never approves anything that needs approving. `canSend` is the
  // same gate the button meets.
  const gate = canSend(order.status, order.approvalRequired)
  if (!gate.ok) return gate.reason
  if (order.approvalNowRequired) {
    return 'It is over your approval threshold as things stand now, so it needs approving before it can go out.'
  }

  if (!supplier.hasEmail) return `${supplier.name} has no email address on file, so there is nowhere to send it.`

  if (facts.lines.length === 0) return 'There is nothing on it.'
  for (const line of facts.lines) {
    const cost = Number(line.unitCost)
    if (!line.unitCost || !Number.isFinite(cost) || cost <= 0) {
      return `"${line.description}" has no price on it.`
    }
    if (line.catalogue === 'MISSING') {
      return `"${line.description}" is not on ${supplier.name}'s current price list, so its price is a guess.`
    }
    if (line.catalogue === 'DISCONTINUED') {
      return `"${line.description}" is marked discontinued on ${supplier.name}'s current price list.`
    }
    if (line.catalogue === 'DIFFERENT') {
      return `"${line.description}" is not at the price on ${supplier.name}'s current price list.`
    }
  }

  return null
}

/**
 * The line beside a supplier's switch: how often their automatic drafts were
 * changed by a person before they went. For information only - the owner
 * decides, and nothing turns itself off on the strength of it.
 */
export function editRecordSentence(record: { drafts: number; changed: number } | null | undefined, recordSize: number): string {
  if (!record || record.drafts === 0) {
    return 'No automatic drafts to this supplier yet, so there is no record to go on.'
  }
  const { drafts, changed } = record
  const which = drafts >= recordSize
    ? `Of the last ${drafts} automatic drafts to this supplier`
    : drafts === 1
      ? 'Of the one automatic draft to this supplier so far'
      : `Of the ${drafts} automatic drafts to this supplier so far`
  const how = changed === 0
    ? 'none was changed before it was sent'
    : drafts === 1
      ? 'it was changed before it was sent'
      : `${changed} ${changed === 1 ? 'was' : 'were'} changed before ${changed === 1 ? 'it was' : 'they were'} sent`
  return `${which}, ${how}.`
}

/**
 * What a draft's place in the automatic queue looks like on a screen - the
 * customer order's Purchasing panel and the order itself - or null for a draft
 * with nothing to say (never queued, or not a draft any more).
 *
 * The time is the wall clock where the business is, not the server's: "14:30"
 * on a server in UTC is half past three in a British summer.
 */
export function autoSendLine(
  facts: { status: PoStatus; autoSendState: string | null; autoSendNote: string | null; autoSendDueAt: string | null },
  now: Date,
  timezone: string,
): { tone: 'info' | 'warning'; text: string } | null {
  if (facts.status !== 'DRAFT') return null
  switch (facts.autoSendState) {
    case 'QUEUED': {
      if (!facts.autoSendDueAt) return null
      const due = new Date(facts.autoSendDueAt)
      if (due.getTime() <= now.getTime()) {
        return { tone: 'info', text: 'Sends automatically at the next half-hourly check unless you open it and change it.' }
      }
      const time = formatInSiteTimezone(due, timezone, { hour: '2-digit', minute: '2-digit', hour12: false })
      const sameDay = calendarDateIn(due, timezone) === calendarDateIn(now, timezone)
      const day = sameDay ? '' : ` on ${formatInSiteTimezone(due, timezone, { weekday: 'long', day: 'numeric', month: 'short' })}`
      return { tone: 'info', text: `Sends automatically at ${time}${day} unless you open it and change it.` }
    }
    case 'HELD':
      return { tone: 'info', text: `Not sending automatically: ${facts.autoSendNote ?? 'a person changed it, so a person sends it.'}` }
    case 'REFUSED':
      return { tone: 'warning', text: `Not sent automatically: ${facts.autoSendNote ?? 'something about it was not certain.'} Send it yourself once it is right.` }
    default:
      return null
  }
}

/** What happens to a draft whose email would not go: tried again next time,
 *  or - out of tries - refused with the mailer's own words. */
export function afterFailedSend(attemptsSoFar: number, mailerSaid: string): { retry: true } | { retry: false; note: string } {
  if (attemptsSoFar + 1 < MAX_SEND_ATTEMPTS) return { retry: true }
  return {
    retry: false,
    note: `The email would not go after ${MAX_SEND_ATTEMPTS} tries. The mail server said: ${mailerSaid}`,
  }
}
