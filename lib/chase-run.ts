import { recordAudit } from './audit'
import { gatherChaseFacts, outstandingLinesFor } from './chase'
import { chaseReview, type ChaseFact } from './chasing'
import { getPoConfigCached } from './config'
import { sendOrderChase, supplierRecipients } from './email'
import { mintPortalLink } from './portal'
import { reportToday } from './reports'
import type { PoChaseRunResult } from './types'

// The one thing that actually chases a supplier. The nightly job and the button
// on the Reports tab both come through here, so what somebody read on the screen
// is what they get when they press it - the same arrangement lib/reorder-run.ts
// has, for the same reason.
//
// Nothing here changes an order. A chase is a question, not a decision: the
// order keeps its status, its dates and its lines, and all that is written is a
// line in its history saying somebody asked.

export type ChaseRunOptions = {
  /** Null for the nightly job - nobody pressed anything. */
  userId: string | null
  /**
   * Null runs what the nightly job would run: everything the settings say is
   * due, and only while chasing is switched on. A list of order ids is a person
   * overriding both of those.
   */
  orderIds: string[] | null
}

export async function runChase(options: ChaseRunOptions): Promise<PoChaseRunResult> {
  const result: PoChaseRunResult = { chased: [], failed: [], skipped: 0, heldBack: null }

  const config = await getPoConfigCached()
  const automatic = options.orderIds === null

  if (automatic && !config.chaseEnabled) {
    return {
      ...result,
      heldBack: 'Chasing is switched off in the purchasing settings, so nothing was sent.',
    }
  }

  const facts = await gatherChaseFacts()
  const decisions = chaseReview(facts, config, reportToday())
  const byId = new Map<string, ChaseFact>(facts.map((fact) => [fact.orderId, fact]))
  const wanted = options.orderIds === null ? null : new Set(options.orderIds)

  for (const decision of decisions) {
    // A named order is somebody having decided it is worth a nudge, so "not late
    // enough yet" and "already chased this week" both give way. What never gives
    // way is having somewhere to send it - see below.
    const chosen = wanted ? wanted.has(decision.orderId) : decision.due
    if (!chosen) {
      result.skipped += 1
      continue
    }

    const fact = byId.get(decision.orderId)
    const recipients = fact ? supplierRecipients(fact.supplierEmail, fact.supplierEmailCc) : null
    if (!fact || !recipients) {
      result.failed.push({
        orderId: decision.orderId,
        orderNumber: decision.orderNumber,
        message: 'This supplier has no email address on file, so there is nowhere to send it.',
      })
      continue
    }

    try {
      const lines = await outstandingLinesFor(fact.orderId)
      // A fresh link per chase, for the same reason the order email gets one:
      // the raw token is never stored, so an old one cannot be recovered. Null
      // where the owner has supplier links switched off, in which case the
      // template's link paragraph renders as nothing at all.
      const portalLink = await mintPortalLink(fact.orderId, fact.orderNumber, options.userId)
      await sendOrderChase(
        fact.supplierName,
        fact.orderNumber,
        recipients,
        {
          dueDate: decision.dueDate ?? 'the date we agreed',
          daysLate: Math.max(1, decision.daysLate),
          lines,
        },
        portalLink,
      )

      // Written only once the email has actually gone. A chase recorded for one
      // that bounced is what stops the next one being sent, which is the exact
      // opposite of what this is for.
      await recordAudit(
        'order',
        fact.orderId,
        'order.chased',
        {
          to: recipients.to,
          cc: recipients.cc,
          daysLate: decision.daysLate,
          dueDate: decision.dueDate,
          automatic,
        },
        options.userId,
      )

      result.chased.push({
        orderId: fact.orderId,
        orderNumber: fact.orderNumber,
        supplierName: fact.supplierName,
        to: recipients.to,
      })
    } catch (error) {
      // One supplier's bounced address must not stop the other nine being asked.
      const message = error instanceof Error ? error.message : 'The chase could not be sent.'
      console.error('[purchase-orders] could not chase order', fact.orderNumber, error)
      result.failed.push({ orderId: fact.orderId, orderNumber: fact.orderNumber, message })
    }
  }

  return result
}
