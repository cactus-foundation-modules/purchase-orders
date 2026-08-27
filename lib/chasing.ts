import { daysBetween, dueDateOf } from './reporting'
import type { PoChaseDecision, PoStatus } from './types'

// Who gets chased, and when. Pure: no database, no clock, no config reader.
//
// The whole file exists so that the nightly job and the button on the Reports
// tab cannot disagree. Somebody who reads "three of these are due a chase" and
// presses the button gets exactly those three, and the job at six in the morning
// would have sent exactly those three.
//
// The hard part of chasing is not sending the email. It is not sending it to a
// supplier who has done nothing wrong - which is why every rule below errs
// towards saying nothing.

/** Everything one order contributes to the decision. */
export type ChaseFact = {
  orderId: string
  orderNumber: string
  status: PoStatus
  supplierId: string
  supplierName: string
  supplierEmail: string | null
  supplierEmailCc: string | null
  /** Null until the order actually went out. */
  sentAt: string | null
  expectedDate: string | null
  requiredByDate: string | null
  /** Off po_audit_log, not off a column - see the note in lib/chase.ts. */
  lastChasedAt: string | null
  /** Lines still owing something. Zero means everything has arrived. */
  outstandingLines: number
}

export type ChaseSettings = {
  chaseEnabled: boolean
  chaseAfterDays: number
  chaseRepeatDays: number
}

/**
 * Statuses that are still waiting on a supplier.
 *
 * ON_HOLD is deliberately absent. Putting an order on hold is somebody saying
 * "leave this alone", and a job that emails the supplier about it anyway is a
 * job that has ignored the only instruction it was given.
 */
const CHASEABLE: PoStatus[] = ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED']

/**
 * Whether this order is due a chase today, and if not, why not.
 *
 * `due` is the only field the job acts on. `reason` is what the screen shows
 * beside every order it did not chase, because "nothing happened" is the worst
 * possible answer to give somebody who has just switched chasing on.
 */
export function chaseDecision(fact: ChaseFact, settings: ChaseSettings, today: string): PoChaseDecision {
  const base = {
    orderId: fact.orderId,
    orderNumber: fact.orderNumber,
    supplierId: fact.supplierId,
    supplierName: fact.supplierName,
    dueDate: dueDateOf(fact),
    daysLate: 0,
    lastChasedAt: fact.lastChasedAt,
  }

  if (!fact.sentAt || !CHASEABLE.includes(fact.status)) {
    return { ...base, due: false, reason: 'This one is not out with a supplier waiting on them.' }
  }
  if (fact.outstandingLines === 0) {
    return { ...base, due: false, reason: 'Everything on it has arrived.' }
  }

  const due = base.dueDate
  if (!due) {
    return {
      ...base,
      due: false,
      reason: 'Nobody put a date on it, so there is nothing to be late against. Add an expected date and it joins in.',
    }
  }

  const daysLate = daysBetween(due, today)
  if (daysLate < settings.chaseAfterDays || daysLate <= 0) {
    return { ...base, due: false, daysLate: Math.max(0, daysLate), reason: 'Not late enough yet.' }
  }

  const to = (fact.supplierEmail ?? '').trim()
  if (!to.includes('@')) {
    return {
      ...base,
      due: false,
      daysLate,
      reason: 'This supplier has no email address on file, so there is nowhere to send it.',
    }
  }

  if (fact.lastChasedAt) {
    const sinceLast = daysBetween(fact.lastChasedAt, today)
    // Repeat of zero means "chase once and then leave them alone". A zero that
    // meant "every day" would turn a forgotten order into a daily nuisance, and
    // nobody sets a repeat interval expecting that.
    if (settings.chaseRepeatDays <= 0) {
      return { ...base, due: false, daysLate, reason: 'Already chased once, and repeats are switched off.' }
    }
    if (sinceLast < settings.chaseRepeatDays) {
      const wait = settings.chaseRepeatDays - sinceLast
      return {
        ...base,
        due: false,
        daysLate,
        reason: `Chased ${sinceLast === 0 ? 'today' : sinceLast === 1 ? 'yesterday' : `${sinceLast} days ago`}; the next one is ${wait === 1 ? 'tomorrow' : `in ${wait} days`}.`,
      }
    }
  }

  return {
    ...base,
    due: true,
    daysLate,
    reason: fact.lastChasedAt ? 'Still late, and due another nudge.' : 'Late, and nobody has said anything yet.',
  }
}

/**
 * The whole list, chased ones first and worst first within that.
 *
 * `chaseEnabled` is honoured by the JOB, not by this function: the Reports tab
 * still works out who is late with chasing switched off, and the button still
 * sends when somebody presses it. A switch that hides the information as well as
 * holding the emails is a switch nobody can make an informed decision about.
 */
export function chaseReview(
  facts: ChaseFact[],
  settings: ChaseSettings,
  today: string,
): PoChaseDecision[] {
  return facts
    .map((fact) => chaseDecision(fact, settings, today))
    .sort((a, b) => Number(b.due) - Number(a.due) || b.daysLate - a.daysLate || a.orderNumber.localeCompare(b.orderNumber))
}
