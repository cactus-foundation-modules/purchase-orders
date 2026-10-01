import { prisma } from '@/lib/db/prisma'
import { getOrder, getSupplier, recordOrderSent, setOrderStatus } from './db'
import { loadPoDocContext, supplierParty, wordingSnapshot } from './document'
import { sendOrderToSupplier, supplierRecipients } from './email'
import { recordAudit } from './audit'
import { mintPortalLink } from './portal'
import { canSend, sendingApproves } from './lifecycle'
import { BEING_SENT_AUTOMATICALLY, CLAIM_MINUTES } from './auto-send'
import { recordRefusalAudit, takeOutOfQueue } from './auto-send-queue'

// Emailing a purchase order to its supplier: the one implementation behind the
// Send button and the automatic job alike, so the two cannot drift apart - same
// gate, same email, same link, same history, same status change.
//
// The order of the two halves is the whole design: the email goes FIRST, and
// the order is only stamped as sent once it has actually gone. Stamping first
// and mailing after would leave an order reading "Sent" that nobody ever
// received, which is how a business ends up waiting six weeks for goods it
// never ordered.
//
// Where the automatic queue is involved, the person and the job meet on the
// row itself, never on what either of them read a moment ago:
//  - a person's send of a queued draft first takes it out of the queue
//    (`takeOutOfQueue`) - refused while the job holds a claim on it;
//  - the job, after drawing the document and just before mailing, marks the
//    row SENT in one UPDATE that also checks its claim still stands and the
//    row is exactly as it read it. Anything else, and it sends nothing.
//  - the moment its email has gone, nothing the job does afterwards can lead to
//    the order being emailed again: a failure to record it is a REFUSED with a
//    sentence for a person, never a retry.

export type SendRunBy = 'USER' | 'AUTO'

export type SendRunOptions = {
  orderId: string
  /** Whoever pressed Send. Null for the automatic job, which is nobody. */
  userId: string | null
  by: SendRunBy
  /** Goes in the email, and into the history. */
  note?: string | null
  /** USER: who pressed Send, for the note on a draft this takes out of the
   *  automatic queue. */
  personName?: string | null
  /** USER: when the order was last sent as the person's screen showed it
   *  (null for never). Given, and it no longer matches, the send is refused -
   *  an order the job sent a moment ago would otherwise go out again as an
   *  "amendment". Left out, it is not checked. */
  seenSentAt?: string | null
  /** AUTO: the row's `updated_at` as text, as the job read it before checking
   *  the draft. Anything written to the order since, and it is not sent. Read
   *  here if not given. */
  autoStamp?: string | null
}

export type SendRunResult =
  | { outcome: 'sent'; kind: 'sent' | 'amended'; to: string; cc: string[] }
  /** Not sent, and nothing written. `status` is what the route answers with. */
  | { outcome: 'refused'; reason: string; status: 404 | 409 }
  /** The mailer would not take it, in its own words. Nothing written (the job's
   *  draft is back in the queue, claim and all, for it to count the try). */
  | { outcome: 'failed'; error: string }
  /** AUTO: the draft changed, or the claim lapsed, while the document was being
   *  drawn. Nothing sent; still queued if nobody took it out. */
  | { outcome: 'stale' }
  /** AUTO: the email went, and recording it did not. The draft is REFUSED with
   *  a sentence saying so - and never emailed again by the job. */
  | { outcome: 'unrecorded'; error: string }

const GONE = 'That purchase order is not here any more.'

export async function sendOrderRun(options: SendRunOptions): Promise<SendRunResult> {
  const { orderId: id, userId, by } = options
  const note = options.note ?? null

  const order = await getOrder(id)
  if (!order) return { outcome: 'refused', reason: GONE, status: 404 }

  // The job's claim is on a QUEUED row. A person who changed the draft since
  // it was claimed has taken it out of the queue (HELD), and their version is
  // theirs to send - so the job stops here rather than sending it for them.
  if (by === 'AUTO' && order.autoSendState !== 'QUEUED') {
    return { outcome: 'refused', reason: 'It is no longer waiting to be sent automatically.', status: 409 }
  }
  const stamp = by === 'AUTO' ? (options.autoStamp ?? (await rowStamp(id))) : null

  if (by === 'USER' && options.seenSentAt !== undefined && (order.sentAt ?? null) !== options.seenSentAt) {
    return {
      outcome: 'refused',
      reason: order.autoSendState === 'SENT'
        ? 'This order has just been sent automatically. Look at it again before sending it a second time.'
        : 'This order has been sent since you opened it. Look at it again before sending it a second time.',
      status: 409,
    }
  }

  const gate = canSend(order.status, order.approvalRequired)
  if (!gate.ok) return { outcome: 'refused', reason: gate.reason, status: 409 }

  const supplier = await getSupplier(order.supplierId)
  const recipients = supplierRecipients(supplier?.email ?? null, supplier?.emailCc ?? null)
  if (!recipients) {
    return {
      outcome: 'refused',
      reason: 'This supplier has no email address on file, so there is nowhere to send it.',
      status: 409,
    }
  }

  // A person sending a draft that is (or was a moment ago) in the automatic
  // queue: out of it first, on the row, so the job cannot be emailing it too.
  if (by === 'USER') {
    const who = options.personName?.trim() || 'somebody'
    const queue = await takeOutOfQueue(id, order.autoSendState, `Taken out of the automatic queue when ${who} pressed Send.`)
    if (queue === 'busy') return { outcome: 'refused', reason: BEING_SENT_AUTOMATICALLY, status: 409 }
  }

  // Sending an order nobody formally approved is what approves it, and the copy
  // the supplier gets should say so - see `sendingApproves`. Nothing is written
  // until the email has gone; the document is only DRAWN with the name on it -
  // or, sent by the job, with "Sent automatically" where the name would be.
  const approving = sendingApproves(order.status, order.approvedAt)
  const ctx = await loadPoDocContext(
    id,
    approving ? (userId ? { approvingUserId: userId } : { approvingAutomatically: true }) : undefined,
  )
  if (!ctx) return { outcome: 'refused', reason: GONE, status: 404 }

  // First time out, or an amendment replacing what they already hold. The
  // revision decides rather than the status, because an order can be amended
  // while it is part received and it is still an amendment.
  const kind = order.sentAt ? 'amended' : 'sent'

  // The supplier's own link, minted here so it can travel in the email. Null
  // where the owner has the supplier link switched off, in which case the
  // template's link paragraph renders as nothing at all rather than as an empty
  // invitation.
  const portalLink = await mintPortalLink(id, order.number, userId)

  // The job's last word before the email: its claim still stands, nobody has
  // taken the draft out of the queue, and nothing has been written to it since
  // it was read. All three in the statement that marks it SENT, so there is no
  // moment between checking and marking for a person to save a change in.
  if (by === 'AUTO' && !(await markMailing(id, stamp ?? ''))) return { outcome: 'stale' }

  try {
    await sendOrderToSupplier(ctx, recipients, kind, note, portalLink)
  } catch (error) {
    if (by === 'AUTO') await backToQueue(id)
    return { outcome: 'failed', error: error instanceof Error ? error.message : 'The order could not be sent.' }
  }

  // Everything written once the email has gone, the same for both - a closure
  // so the job can wrap it and a person's send can let it throw as it always has.
  const recordSend = async (): Promise<void> => {
    // Freezes the supplier and the wording onto the order the first time only, so
    // what they were sent stays readable however the records change afterwards.
    await recordOrderSent(id, supplierParty(supplier) as unknown as Record<string, unknown>, await wordingSnapshot(), [
      recipients.to,
      ...recipients.cc,
    ])

    // An order already past SENT keeps the status it has: an amendment to a part
    // received order does not send it back to the beginning.
    if (order.status === 'DRAFT' || order.status === 'APPROVED') {
      // Stamps whoever is sending as the approver, where there was not one - or,
      // for the job, stamps the date and `approved_automatically` instead.
      await setOrderStatus(id, 'SENT', by === 'AUTO' ? { approvedAutomatically: true } : {}, userId)
    }

    // A person's send of a draft they took out of the queue (or that was held
    // before): sent, by hand. The job's own row is already SENT.
    if (by === 'USER') await markSentByHand(id)

    // Its own line in the history, ahead of the send: "who approved this" is a
    // question that gets asked months later, and the answer should not need
    // anybody to know that sending implies it.
    if (approving) {
      await recordAudit(
        'order',
        id,
        'order.approved',
        by === 'AUTO'
          ? { by: 'AUTO', note: 'Approved by sending it to the supplier automatically.' }
          : { by: 'SENDING', note: 'Approved by sending it to the supplier.' },
        userId,
      )
    }

    await recordAudit(
      'order',
      id,
      kind === 'sent' ? 'order.sent' : 'order.amendment-sent',
      {
        to: recipients.to,
        cc: recipients.cc,
        revision: order.revision,
        note,
        portalLink: Boolean(portalLink),
        ...(by === 'AUTO' ? { by: 'AUTO' } : {}),
      },
      userId,
    )
  }

  if (by === 'AUTO') {
    // It has gone. Said on the row before anything else is written, and
    // anything that goes wrong from here is for a person, not for a retry.
    await markMailed(id)
    try {
      await recordSend()
      await releaseClaim(id)
    } catch (error) {
      const words = error instanceof Error ? error.message : 'something went wrong'
      await unrecorded(id, words)
      return { outcome: 'unrecorded', error: words }
    }
    return { outcome: 'sent', kind, to: recipients.to, cc: recipients.cc }
  }

  await recordSend()
  return { outcome: 'sent', kind, to: recipients.to, cc: recipients.cc }
}

/** The row's `updated_at`, as text, so a comparison is exact to the
 *  microsecond rather than to whatever a JavaScript Date keeps. */
export async function rowStamp(orderId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ stamp: string }[]>`
    SELECT "updated_at"::text AS "stamp" FROM "po_orders" WHERE "id" = ${orderId}
  `
  return rows[0]?.stamp ?? null
}

/** QUEUED -> SENT ("being emailed now"), only while the job's claim stands and
 *  the row is as it was read. False for anything else: send nothing. */
async function markMailing(orderId: string, stamp: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "po_orders"
       SET "auto_send_state" = 'SENT', "auto_send_note" = 'Being emailed now.'
     WHERE "id" = ${orderId}
       AND "auto_send_state" = 'QUEUED'
       AND "auto_send_claimed_at" IS NOT NULL
       AND "auto_send_claimed_at" >= now() - make_interval(mins => ${CLAIM_MINUTES}::int)
       AND "updated_at"::text = ${stamp}
    RETURNING "id"
  `
  return rows.length > 0
}

/** The mail server said no: back in the queue, claim kept, for the job to
 *  count the try and let go of it. */
async function backToQueue(orderId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders" SET "auto_send_state" = 'QUEUED', "auto_send_note" = NULL
     WHERE "id" = ${orderId} AND "auto_send_state" = 'SENT'
  `
}

/** The email has gone. The claim stays on until everything is recorded, so a
 *  person cannot save a change into the middle of that either. */
async function markMailed(orderId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders" SET "auto_send_note" = 'Sent automatically.' WHERE "id" = ${orderId}
  `
}

async function releaseClaim(orderId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders" SET "auto_send_claimed_at" = NULL WHERE "id" = ${orderId} AND "auto_send_state" = 'SENT'
  `
}

/** Sent, and not recorded: for a person, with the truth, and never again by
 *  the job. Best-effort itself - if even this cannot be written, the claim is
 *  left on and the next run's sweep says the same thing. The database's own
 *  words go to the log, not into a sentence for the owner. */
async function unrecorded(orderId: string, words: string): Promise<void> {
  console.error('[purchase-orders] automatic send went but was not recorded for', orderId, words)
  const note = 'The email went to the supplier, but the site could not record it on the order. Check the order and mark it as sent - do not send it again.'
  try {
    await prisma.$executeRaw`
      UPDATE "po_orders"
         SET "auto_send_state" = 'REFUSED', "auto_send_note" = ${note},
             "auto_send_claimed_at" = NULL, "updated_at" = now()
       WHERE "id" = ${orderId}
    `
    await recordRefusalAudit(orderId, note)
  } catch (error) {
    console.error('[purchase-orders] could not record an unrecorded automatic send for', orderId, error)
  }
}

/** A person's send of a queued or held draft: SENT, by hand. A no-op on an
 *  order that was never queued, or was refused - that keeps its sentence. */
async function markSentByHand(orderId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "auto_send_state" = 'SENT', "auto_send_note" = 'Sent by hand.', "auto_send_claimed_at" = NULL
     WHERE "id" = ${orderId} AND "auto_send_state" IN ('QUEUED', 'HELD')
  `
}
